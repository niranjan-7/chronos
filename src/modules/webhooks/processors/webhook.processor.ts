import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { CircuitState, WebhookDeliveryStatus } from '@prisma/client';
import { PrismaService } from '../../../common/database/prisma.service';
import {
  HTTP_HARD_TIMEOUT_MS,
  WEBHOOK_DISPATCHER_QUEUE,
} from '../constants/webhook.constants';
import { WebhookJobPayload } from '../interfaces/webhook-job-payload.interface';
import { WebhookCryptoService } from '../services/webhook-crypto.service';
import { CircuitBreakerService } from '../services/circuit-breaker.service';

import { Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Processor(WEBHOOK_DISPATCHER_QUEUE)
export class WebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookProcessor.name);
  private readonly crypto: WebhookCryptoService;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() cryptoService?: WebhookCryptoService,
    @Optional() private readonly circuitBreakerService?: CircuitBreakerService,
  ) {
    super();
    this.crypto = cryptoService || new WebhookCryptoService(new ConfigService());
  }

  /**
   * Processes outbound webhook dispatch with:
   * 1. Redis sliding-window circuit breaker check (fast-fail if OPEN)
   * 2. HMAC-SHA256 signature (X-Chronos-Signature)
   * 3. Delivery UUID header (X-Chronos-Delivery-Id)
   * 4. 5-second hard timeout (AbortSignal.timeout(5000))
   * 5. Full latency and status code auditing in PostgreSQL
   * 6. Exponential backoff with jitter on transient failures
   */
  async process(job: Job<WebhookJobPayload>): Promise<Record<string, unknown>> {
    const { deliveryId, endpointId, tenantId, url, secret, event, payload } = job.data;
    const currentAttempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts || 5;

    // 1. Verify delivery record exists in PostgreSQL
    const attemptRecord = this.prisma.webhookDeliveryAttempt?.findUnique
      ? await this.prisma.webhookDeliveryAttempt
          .findUnique({
            where: { id: deliveryId },
          })
          .catch(() => null)
      : null;

    // Check legacy delivery log fallback if not found in modern table
    const legacyRecord = !attemptRecord && this.prisma.webhookDeliveryLog?.findUnique
      ? await this.prisma.webhookDeliveryLog
          .findUnique({ where: { id: deliveryId } })
          .catch(() => null)
      : null;

    if (!attemptRecord && !legacyRecord) {
      this.logger.warn(`Webhook delivery record ${deliveryId} not found. Dropping stale job.`);
      return { skipped: true, reason: 'RECORD_NOT_FOUND' };
    }

    // 2. Redis Sliding-Window Circuit Breaker Check
    const effectiveEndpointId = endpointId || attemptRecord?.endpointId || legacyRecord?.subscriptionId || 'default';
    const circuitCheck = this.circuitBreakerService
      ? await this.circuitBreakerService.checkCircuit(tenantId, effectiveEndpointId)
      : { state: CircuitState.CLOSED, canExecute: true, isProbe: false };

    if (!circuitCheck.canExecute) {
      // Circuit is OPEN or probe in-flight: Fast-fail immediately without making HTTP call
      const isTerminal = currentAttempt >= maxAttempts;
      const fastFailReason = circuitCheck.reason || 'Circuit breaker is OPEN. Fast-failing HTTP call.';

      this.logger.warn(
        `[Webhook FAST-FAIL] Endpoint ${effectiveEndpointId} circuit is ${circuitCheck.state}. Fast-failing delivery ${deliveryId} (attempt ${currentAttempt}/${maxAttempts}).`,
      );

      await this.updateDeliveryAttempt(deliveryId, {
        status: isTerminal ? WebhookDeliveryStatus.DEAD_LETTER : WebhookDeliveryStatus.PENDING_RETRY,
        attemptNumber: currentAttempt,
        responseLatencyMs: 0,
        errorMessage: fastFailReason,
        circuitStateAtDispatch: circuitCheck.state,
      });

      throw new Error(`CircuitBreakerFastFail: ${fastFailReason}`);
    }

    // 3. Prepare payload and cryptographic signature
    const decryptedSecret = this.crypto.decryptSecret(secret);
    const bodyString = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const { headerValue: signatureHeader } = this.crypto.createSignatureHeader(
      bodyString,
      decryptedSecret,
      timestamp,
    );

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Chronos-Webhook-Dispatcher/2.0',
      'X-Chronos-Signature': signatureHeader,
      'X-Chronos-Signature-256': signatureHeader, // backwards-compatibility
      'X-Chronos-Delivery-Id': deliveryId,
      'X-Chronos-Delivery': deliveryId, // backwards-compatibility
      'X-Chronos-Event': event,
      'X-Chronos-Tenant': tenantId,
      'X-Chronos-Attempt': currentAttempt.toString(),
    };

    const startTime = Date.now();

    try {
      // 4. Execute HTTP POST with strict 5-second hard timeout
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: bodyString,
        signal: AbortSignal.timeout(HTTP_HARD_TIMEOUT_MS),
      });

      const elapsedMs = Date.now() - startTime;
      const responseText = await response.text().catch(() => '');

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${responseText.slice(0, 500)}`);
      }

      // 5. Success Path: Record attempt and notify circuit breaker
      await this.updateDeliveryAttempt(deliveryId, {
        status: WebhookDeliveryStatus.SUCCESS,
        statusCode: response.status,
        responseLatencyMs: elapsedMs,
        responseBody: responseText.slice(0, 1000),
        attemptNumber: currentAttempt,
        errorMessage: null,
        circuitStateAtDispatch: circuitCheck.state,
      });

      await this.circuitBreakerService?.recordSuccess(
        tenantId,
        effectiveEndpointId,
        circuitCheck.isProbe,
      );

      this.logger.log(
        `Webhook delivery ${deliveryId} to ${url} succeeded (HTTP ${response.status}, ${elapsedMs}ms) on attempt ${currentAttempt}`,
      );

      return {
        success: true,
        statusCode: response.status,
        latencyMs: elapsedMs,
        attempt: currentAttempt,
      };
    } catch (err: unknown) {
      const elapsedMs = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isTimeout =
        (err as any)?.name === 'TimeoutError' ||
        errorMessage.includes('timeout') ||
        elapsedMs >= HTTP_HARD_TIMEOUT_MS;
      const statusCode = (err as any)?.status || (errorMessage.match(/HTTP (\d{3})/) ? parseInt(errorMessage.match(/HTTP (\d{3})/)![1], 10) : undefined);

      const isTerminalFailure = currentAttempt >= maxAttempts;

      // 6. Record failure in Circuit Breaker
      await this.circuitBreakerService?.recordFailure(
        tenantId,
        effectiveEndpointId,
        circuitCheck.isProbe,
        {
          statusCode,
          isTimeout,
          errorMessage,
        },
      );

      // 7. Update database record
      await this.updateDeliveryAttempt(deliveryId, {
        status: isTerminalFailure ? WebhookDeliveryStatus.DEAD_LETTER : WebhookDeliveryStatus.PENDING_RETRY,
        statusCode,
        responseLatencyMs: elapsedMs,
        attemptNumber: currentAttempt,
        errorMessage: isTerminalFailure
          ? `Terminal failure after ${currentAttempt} attempts: ${errorMessage}`
          : errorMessage,
        circuitStateAtDispatch: circuitCheck.state,
      });

      if (isTerminalFailure) {
        this.logger.error(
          `[WEBHOOK DLQ] Delivery ${deliveryId} to ${url} permanently failed after ${currentAttempt} attempts. Moved to DLQ.`,
        );
        throw new Error(`Terminal webhook failure: ${errorMessage}`);
      }

      this.logger.warn(
        `Webhook delivery ${deliveryId} failed attempt ${currentAttempt}/${maxAttempts} (${errorMessage}). Retrying with jitter backoff...`,
      );

      throw err;
    }
  }

  /**
   * Updates delivery status across modern WebhookDeliveryAttempt and legacy WebhookDeliveryLog.
   */
  private async updateDeliveryAttempt(
    deliveryId: string,
    data: {
      status: WebhookDeliveryStatus;
      statusCode?: number;
      responseLatencyMs?: number;
      responseBody?: string;
      attemptNumber: number;
      errorMessage?: string | null;
      circuitStateAtDispatch?: CircuitState;
    },
  ): Promise<void> {
    try {
      // Modern table
      if (this.prisma.webhookDeliveryAttempt?.updateMany) {
        await this.prisma.webhookDeliveryAttempt.updateMany({
          where: { id: deliveryId },
          data: {
            status: data.status,
            statusCode: data.statusCode,
            responseLatencyMs: data.responseLatencyMs,
            responseBody: data.responseBody,
            attemptNumber: data.attemptNumber,
            errorMessage: data.errorMessage,
            circuitStateAtDispatch: data.circuitStateAtDispatch,
          },
        }).catch(() => {});
      } else if (this.prisma.webhookDeliveryAttempt?.update) {
        await this.prisma.webhookDeliveryAttempt.update({
          where: { id: deliveryId },
          data: {
            status: data.status,
            statusCode: data.statusCode,
            responseLatencyMs: data.responseLatencyMs,
            responseBody: data.responseBody,
            attemptNumber: data.attemptNumber,
            errorMessage: data.errorMessage,
            circuitStateAtDispatch: data.circuitStateAtDispatch,
          },
        }).catch(() => {});
      }

      // Legacy table
      if (this.prisma.webhookDeliveryLog?.updateMany) {
        await this.prisma.webhookDeliveryLog.updateMany({
          where: { id: deliveryId },
          data: {
            status: data.status,
            statusCode: data.statusCode,
            responseBody: data.responseBody,
            attempts: data.attemptNumber,
            lastError: data.errorMessage,
          },
        }).catch(() => {});
      } else if (this.prisma.webhookDeliveryLog?.update) {
        await this.prisma.webhookDeliveryLog.update({
          where: { id: deliveryId },
          data: {
            status: data.status,
            statusCode: data.statusCode,
            responseBody: data.responseBody,
            attempts: data.attemptNumber,
            lastError: data.errorMessage,
          },
        }).catch(() => {});
      }
    } catch (err: any) {
      this.logger.error(`Failed to update webhook delivery record ${deliveryId}: ${err.message}`);
    }
  }
}
