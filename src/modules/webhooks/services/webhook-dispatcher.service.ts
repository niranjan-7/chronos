import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as crypto from 'crypto';
import { CircuitState, Prisma, WebhookDeliveryStatus } from '@prisma/client';
import { PrismaService } from '../../../common/database/prisma.service';
import {
  WEBHOOK_DISPATCHER_QUEUE,
  WEBHOOK_JOB_DISPATCH,
} from '../constants/webhook.constants';
import { WebhookJobPayload } from '../interfaces/webhook-job-payload.interface';
import { WebhookCryptoService } from './webhook-crypto.service';
import { CircuitBreakerService } from './circuit-breaker.service';
import { CreateWebhookEndpointDto } from '../dto/create-webhook-endpoint.dto';
import { UpdateWebhookEndpointDto } from '../dto/update-webhook-endpoint.dto';

@Injectable()
export class WebhookDispatcherService {
  private readonly logger = new Logger(WebhookDispatcherService.name);
  private readonly cryptoService: WebhookCryptoService;
  private readonly circuitBreakerService?: CircuitBreakerService;

  constructor(
    @InjectQueue(WEBHOOK_DISPATCHER_QUEUE)
    private readonly webhookQueue: Queue<WebhookJobPayload>,
    private readonly prisma: PrismaService,
    @Optional() cryptoService?: WebhookCryptoService,
    @Optional() circuitBreakerService?: CircuitBreakerService,
  ) {
    this.cryptoService = cryptoService || new WebhookCryptoService(new ConfigService());
    this.circuitBreakerService = circuitBreakerService;
  }

  /**
   * Matches active tenant webhook endpoints for the event and enqueues
   * dispatch jobs with exponential backoff and jitter (max 5 retries).
   */
  async dispatchEvent(
    tenantId: string,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<number> {
    // 1. Fetch modern WebhookEndpoints
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: {
        tenantId,
        isActive: true,
      },
    });

    const matchingEndpoints = endpoints.filter(
      (ep) =>
        ep.subscribedEvents.length === 0 ||
        ep.subscribedEvents.includes('*') ||
        ep.subscribedEvents.includes(event),
    );

    // 2. Fetch legacy WebhookSubscriptions for backwards-compatibility
    const legacySubs = await this.prisma.webhookSubscription.findMany({
      where: {
        tenantId,
        isActive: true,
      },
    });

    const matchingLegacy = legacySubs.filter(
      (sub) =>
        sub.events.length === 0 ||
        sub.events.includes('*') ||
        sub.events.includes(event),
    );

    const totalDispatches = matchingEndpoints.length + matchingLegacy.length;
    if (totalDispatches === 0) {
      return 0;
    }

    this.logger.debug(
      `Dispatching event '${event}' to ${matchingEndpoints.length} endpoint(s) and ${matchingLegacy.length} legacy sub(s) for tenant ${tenantId}`,
    );

    // Enqueue modern endpoint dispatches
    for (const ep of matchingEndpoints) {
      const deliveryAttempt = await this.prisma.webhookDeliveryAttempt.create({
        data: {
          tenantId,
          endpointId: ep.id,
          event,
          payload: payload as Prisma.InputJsonValue,
          status: WebhookDeliveryStatus.PENDING_RETRY,
          attemptNumber: 0,
        },
      });

      await this.webhookQueue.add(
        WEBHOOK_JOB_DISPATCH,
        {
          deliveryId: deliveryAttempt.id,
          endpointId: ep.id,
          tenantId,
          url: ep.url,
          secret: ep.signingSecret,
          event,
          payload,
        },
        {
          jobId: `wh-${deliveryAttempt.id}`,
          attempts: 5,
          backoff: {
            type: 'exponentialWithJitter',
          },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    }

    // Enqueue legacy dispatches if any
    for (const sub of matchingLegacy) {
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

      await this.webhookQueue.add(
        WEBHOOK_JOB_DISPATCH,
        {
          deliveryId: deliveryLog.id,
          endpointId: sub.id,
          tenantId,
          url: sub.url,
          secret: sub.secret,
          event,
          payload,
        },
        {
          jobId: `wh-legacy-${deliveryLog.id}`,
          attempts: 5,
          backoff: {
            type: 'exponentialWithJitter',
          },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    }

    return totalDispatches;
  }

  /**
   * Replays a single Dead Letter Queue delivery attempt.
   */
  async replayDeadLetterDelivery(tenantId: string, deliveryId: string) {
    // 1. Try modern WebhookDeliveryAttempt
    const attempt = await this.prisma.webhookDeliveryAttempt.findFirst({
      where: { id: deliveryId, tenantId },
      include: { endpoint: true },
    });

    if (attempt) {
      await this.prisma.webhookDeliveryAttempt.update({
        where: { id: deliveryId },
        data: {
          status: WebhookDeliveryStatus.PENDING_RETRY,
          attemptNumber: 0,
          errorMessage: null,
        },
      });

      await this.webhookQueue.add(
        WEBHOOK_JOB_DISPATCH,
        {
          deliveryId: attempt.id,
          endpointId: attempt.endpointId,
          tenantId,
          url: attempt.endpoint.url,
          secret: attempt.endpoint.signingSecret,
          event: attempt.event,
          payload: attempt.payload as Record<string, unknown>,
        },
        {
          jobId: `wh-replay-${attempt.id}-${Date.now()}`,
          attempts: 5,
          backoff: {
            type: 'exponentialWithJitter',
          },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );

      return { replayed: true, retried: true, deliveryId, endpointId: attempt.endpointId };
    }

    // 2. Try legacy WebhookDeliveryLog
    const legacy = await this.prisma.webhookDeliveryLog.findFirst({
      where: { id: deliveryId, tenantId },
      include: { subscription: true },
    });

    if (legacy) {
      await this.prisma.webhookDeliveryLog.update({
        where: { id: deliveryId },
        data: {
          status: WebhookDeliveryStatus.PENDING_RETRY,
          attempts: 0,
          lastError: null,
        },
      });

      await this.webhookQueue.add(
        WEBHOOK_JOB_DISPATCH,
        {
          deliveryId: legacy.id,
          endpointId: legacy.subscriptionId,
          tenantId,
          url: legacy.subscription.url,
          secret: legacy.subscription.secret,
          event: legacy.event,
          payload: legacy.payload as Record<string, unknown>,
        },
        {
          jobId: `wh-legacy-replay-${legacy.id}-${Date.now()}`,
          attempts: 5,
          backoff: {
            type: 'exponentialWithJitter',
          },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );

      return { replayed: true, retried: true, deliveryId, endpointId: legacy.subscriptionId };
    }

    throw new NotFoundException(`Dead Letter delivery '${deliveryId}' not found for tenant.`);
  }

  /**
   * Replays ALL Dead Letter Queue deliveries for a given endpoint.
   */
  async replayAllEndpointFailures(tenantId: string, endpointId: string) {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, tenantId },
    });

    if (!endpoint) {
      throw new NotFoundException(`Webhook endpoint '${endpointId}' not found for tenant.`);
    }

    const failedAttempts = await this.prisma.webhookDeliveryAttempt.findMany({
      where: {
        tenantId,
        endpointId,
        status: WebhookDeliveryStatus.DEAD_LETTER,
      },
    });

    if (failedAttempts.length === 0) {
      return { replayedCount: 0, endpointId };
    }

    // Reset status in DB
    const ids = failedAttempts.map((a) => a.id);
    await this.prisma.webhookDeliveryAttempt.updateMany({
      where: { id: { in: ids } },
      data: {
        status: WebhookDeliveryStatus.PENDING_RETRY,
        attemptNumber: 0,
        errorMessage: null,
      },
    });

    // Bulk enqueue in BullMQ
    const bulkJobs = failedAttempts.map((attempt) => ({
      name: WEBHOOK_JOB_DISPATCH,
      data: {
        deliveryId: attempt.id,
        endpointId: endpoint.id,
        tenantId,
        url: endpoint.url,
        secret: endpoint.signingSecret,
        event: attempt.event,
        payload: attempt.payload as Record<string, unknown>,
      },
      opts: {
        jobId: `wh-replay-all-${attempt.id}-${Date.now()}`,
        attempts: 5,
        backoff: {
          type: 'exponentialWithJitter',
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }));

    await this.webhookQueue.addBulk(bulkJobs);

    this.logger.log(
      `Replayed ${failedAttempts.length} Dead Letter deliveries for endpoint ${endpointId}`,
    );

    return {
      replayedCount: failedAttempts.length,
      endpointId,
    };
  }

  /**
   * Returns DLQ deliveries for tenant inspection (both modern and legacy).
   */
  async getDeadLetterQueue(tenantId: string, limit = 50) {
    const modernAttempts = await this.prisma.webhookDeliveryAttempt.findMany({
      where: {
        tenantId,
        status: WebhookDeliveryStatus.DEAD_LETTER,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        endpoint: {
          select: { id: true, url: true, circuitState: true, subscribedEvents: true },
        },
      },
    });

    const legacyLogs = await this.prisma.webhookDeliveryLog.findMany({
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

    return [...modernAttempts, ...legacyLogs];
  }

  /**
   * Onboards a new webhook endpoint with AES-256-GCM secret encryption.
   */
  async createEndpoint(tenantId: string, dto: CreateWebhookEndpointDto) {
    const rawSecret = dto.signingSecret || `sec_${crypto.randomBytes(24).toString('hex')}`;
    const encryptedSecret = this.cryptoService.encryptSecret(rawSecret);

    const endpoint = await this.prisma.webhookEndpoint.create({
      data: {
        tenantId,
        url: dto.url,
        signingSecret: encryptedSecret,
        subscribedEvents: dto.subscribedEvents ?? ['sla.warning', 'sla.breach', 'ticket.escalated'],
        isActive: dto.isActive ?? true,
        circuitState: CircuitState.CLOSED,
      },
    });

    return {
      ...endpoint,
      signingSecret: rawSecret, // return raw secret only once upon creation
    };
  }

  async listEndpoints(tenantId: string) {
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        tenantId: true,
        url: true,
        subscribedEvents: true,
        isActive: true,
        circuitState: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Attach live circuit status from Redis for each endpoint
    const enriched = await Promise.all(
      endpoints.map(async (ep) => {
        const liveCircuit = this.circuitBreakerService
          ? await this.circuitBreakerService.getCircuitStatus(tenantId, ep.id)
          : null;
        return {
          ...ep,
          liveCircuit,
        };
      }),
    );

    return enriched;
  }

  async getEndpoint(tenantId: string, endpointId: string) {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, tenantId },
    });

    if (!endpoint) {
      throw new NotFoundException(`Webhook endpoint '${endpointId}' not found.`);
    }

    const liveCircuit = this.circuitBreakerService
      ? await this.circuitBreakerService.getCircuitStatus(tenantId, endpointId)
      : null;

    return {
      id: endpoint.id,
      tenantId: endpoint.tenantId,
      url: endpoint.url,
      subscribedEvents: endpoint.subscribedEvents,
      isActive: endpoint.isActive,
      circuitState: endpoint.circuitState,
      liveCircuit,
      createdAt: endpoint.createdAt,
      updatedAt: endpoint.updatedAt,
    };
  }

  async updateEndpoint(tenantId: string, endpointId: string, dto: UpdateWebhookEndpointDto) {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, tenantId },
    });

    if (!endpoint) {
      throw new NotFoundException(`Webhook endpoint '${endpointId}' not found.`);
    }

    const data: Prisma.WebhookEndpointUpdateInput = {};
    if (dto.url) data.url = dto.url;
    if (dto.subscribedEvents) data.subscribedEvents = dto.subscribedEvents;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.signingSecret) {
      data.signingSecret = this.cryptoService.encryptSecret(dto.signingSecret);
    }

    return this.prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data,
    });
  }

  async deleteEndpoint(tenantId: string, endpointId: string) {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, tenantId },
    });

    if (!endpoint) {
      throw new NotFoundException(`Webhook endpoint '${endpointId}' not found.`);
    }

    await this.circuitBreakerService?.resetCircuit(tenantId, endpointId);

    await this.prisma.webhookEndpoint.delete({
      where: { id: endpointId },
    });

    return { deleted: true, endpointId };
  }

  // --- Backwards-compatibility methods for Phase 4 endpoints and tests ---

  async createSubscription(tenantId: string, dto: { url: string; secret?: string; events?: string[] }) {
    return this.prisma.webhookSubscription.create({
      data: {
        tenantId,
        url: dto.url,
        secret: dto.secret || `sec_${crypto.randomBytes(24).toString('hex')}`,
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

  async retryDeadLetterJob(deliveryId: string, tenantId: string) {
    return this.replayDeadLetterDelivery(tenantId, deliveryId);
  }
}
