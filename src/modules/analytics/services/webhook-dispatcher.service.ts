import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma, WebhookDeliveryStatus } from '@prisma/client';
import { PrismaService } from '../../../common/database/prisma.service';
import {
  WEBHOOK_DISPATCHER_QUEUE,
  WEBHOOK_JOB_DISPATCH,
} from '../constants/webhook.constants';
import { WebhookJobPayload } from '../interfaces/webhook-job-payload.interface';
import { CreateWebhookSubscriptionDto } from '../dto/create-webhook-subscription.dto';

@Injectable()
export class WebhookDispatcherService {
  private readonly logger = new Logger(WebhookDispatcherService.name);

  constructor(
    @InjectQueue(WEBHOOK_DISPATCHER_QUEUE)
    private readonly webhookQueue: Queue<WebhookJobPayload>,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Matches active tenant webhook subscriptions for the event and enqueues
   * dispatch jobs with exponential backoff (max 5 retries).
   */
  async dispatchEvent(
    tenantId: string,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<number> {
    const subscriptions = await this.prisma.webhookSubscription.findMany({
      where: {
        tenantId,
        isActive: true,
      },
    });

    const matching = subscriptions.filter(
      (sub) => sub.events.length === 0 || sub.events.includes('*') || sub.events.includes(event),
    );

    if (matching.length === 0) {
      return 0;
    }

    this.logger.debug(
      `Dispatching event '${event}' to ${matching.length} webhook endpoint(s) for tenant ${tenantId}`,
    );

    for (const sub of matching) {
      // 1. Create initial delivery log
      const deliveryLog = await this.prisma.webhookDeliveryLog.create({
        data: {
          tenantId,
          subscriptionId: sub.id,
          event,
          payload: payload as Prisma.InputJsonValue,
          status: WebhookDeliveryStatus.PENDING_RETRY,
          attempts: 0,
        },
      });

      // 2. Enqueue BullMQ job with max 5 attempts and exponential backoff
      await this.webhookQueue.add(
        WEBHOOK_JOB_DISPATCH,
        {
          deliveryId: deliveryLog.id,
          subscriptionId: sub.id,
          tenantId,
          url: sub.url,
          secret: sub.secret,
          event,
          payload,
        },
        {
          jobId: `wh-${deliveryLog.id}`,
          attempts: 5,
          backoff: {
            type: 'exponential',
            delay: 2000, // 2s, 4s, 8s, 16s, 32s
          },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    }

    return matching.length;
  }

  /**
   * Lists failed/dead-letter webhook deliveries for tenant admins to inspect.
   */
  async getDeadLetterQueue(tenantId: string, limit = 50) {
    return this.prisma.webhookDeliveryLog.findMany({
      where: {
        tenantId,
        status: WebhookDeliveryStatus.DEAD_LETTER,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        subscription: {
          select: { id: true, url: true, events: true },
        },
      },
    });
  }

  /**
   * Re-queues a Dead Letter Queue delivery for retry.
   */
  async retryDeadLetterJob(deliveryId: string, tenantId: string) {
    const delivery = await this.prisma.webhookDeliveryLog.findFirst({
      where: { id: deliveryId, tenantId },
      include: { subscription: true },
    });

    if (!delivery) {
      throw new NotFoundException(`Dead Letter Queue delivery '${deliveryId}' not found for tenant.`);
    }

    // Reset status to PENDING_RETRY
    await this.prisma.webhookDeliveryLog.update({
      where: { id: deliveryId },
      data: {
        status: WebhookDeliveryStatus.PENDING_RETRY,
        attempts: 0,
        lastError: null,
      },
    });

    // Re-enqueue job
    await this.webhookQueue.add(
      WEBHOOK_JOB_DISPATCH,
      {
        deliveryId: delivery.id,
        subscriptionId: delivery.subscriptionId,
        tenantId,
        url: delivery.subscription.url,
        secret: delivery.subscription.secret,
        event: delivery.event,
        payload: delivery.payload as Record<string, unknown>,
      },
      {
        jobId: `wh-retry-${delivery.id}-${Date.now()}`,
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    return { retried: true, deliveryId };
  }

  async createSubscription(tenantId: string, dto: CreateWebhookSubscriptionDto) {
    return this.prisma.webhookSubscription.create({
      data: {
        tenantId,
        url: dto.url,
        secret: dto.secret,
        events: dto.events ?? ['*'],
      },
    });
  }

  async listSubscriptions(tenantId: string) {
    return this.prisma.webhookSubscription.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
