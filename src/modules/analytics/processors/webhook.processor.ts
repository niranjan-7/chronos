import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import * as crypto from 'crypto';
import { WebhookDeliveryStatus } from '@prisma/client';
import { PrismaService } from '../../../common/database/prisma.service';
import { WEBHOOK_DISPATCHER_QUEUE } from '../constants/webhook.constants';
import { WebhookJobPayload } from '../interfaces/webhook-job-payload.interface';

@Processor(WEBHOOK_DISPATCHER_QUEUE)
export class WebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  /**
   * Dispatches outbound HTTP webhook with HMAC-SHA256 payload signature.
   * Handles exponential backoff retries (max 5) and records terminal failures to DLQ.
   */
  async process(job: Job<WebhookJobPayload>): Promise<Record<string, unknown>> {
    const { deliveryId, tenantId, url, secret, event, payload } = job.data;
    const currentAttempt = job.attemptsMade + 1;

    // Verify delivery record still exists
    const delivery = await this.prisma.webhookDeliveryLog.findUnique({
      where: { id: deliveryId },
    });
    if (!delivery) {
      this.logger.warn(`Webhook delivery record ${deliveryId} no longer exists. Dropping stale job.`);
      return { skipped: true, reason: 'RECORD_NOT_FOUND' };
    }

    const timestamp = Date.now().toString();
    const bodyString = JSON.stringify(payload);

    // Compute cryptographic HMAC-SHA256 signature
    const signature = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${bodyString}`)
      .digest('hex');

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Chronos-Webhook-Dispatcher/1.0',
      'X-Chronos-Signature-256': `t=${timestamp},v1=${signature}`,
      'X-Chronos-Delivery': deliveryId,
      'X-Chronos-Event': event,
      'X-Chronos-Tenant': tenantId,
      'X-Chronos-Attempt': currentAttempt.toString(),
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: bodyString,
        signal: AbortSignal.timeout(10000), // 10-second timeout
      });

      const responseText = await response.text().catch(() => '');

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${responseText.slice(0, 500)}`);
      }

      // 1. Success path
      await this.prisma.webhookDeliveryLog.update({
        where: { id: deliveryId },
        data: {
          status: WebhookDeliveryStatus.SUCCESS,
          statusCode: response.status,
          responseBody: responseText.slice(0, 1000),
          attempts: currentAttempt,
          lastError: null,
        },
      });

      this.logger.debug(
        `Webhook delivery ${deliveryId} succeeded (HTTP ${response.status}) on attempt ${currentAttempt}`,
      );

      return {
        success: true,
        statusCode: response.status,
        attempt: currentAttempt,
      };
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isTerminalFailure = currentAttempt >= (job.opts.attempts || 5);

      if (isTerminalFailure) {
        // 2. Dead Letter Queue (DLQ): Max 5 attempts exhausted
        await this.prisma.webhookDeliveryLog.update({
          where: { id: deliveryId },
          data: {
            status: WebhookDeliveryStatus.DEAD_LETTER,
            attempts: currentAttempt,
            lastError: `Max attempts exhausted. Terminal error: ${errorMessage}`,
          },
        });

        this.logger.error(
          `[WEBHOOK DLQ] Webhook ${deliveryId} to ${url} permanently failed after ${currentAttempt} attempts. Moved to DLQ.`,
        );

        throw new Error(`Terminal delivery failure: ${errorMessage}`);
      }

      // 3. Transient failure: Mark PENDING_RETRY and throw to trigger BullMQ exponential backoff
      await this.prisma.webhookDeliveryLog.update({
        where: { id: deliveryId },
        data: {
          status: WebhookDeliveryStatus.PENDING_RETRY,
          attempts: currentAttempt,
          lastError: errorMessage,
        },
      });

      this.logger.warn(
        `Webhook ${deliveryId} failed attempt ${currentAttempt}/5 (${errorMessage}). Retrying via exponential backoff...`,
      );

      throw err;
    }
  }
}
