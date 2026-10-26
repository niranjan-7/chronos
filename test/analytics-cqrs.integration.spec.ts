import Redis from 'ioredis';
import { ClsService } from 'nestjs-cls';
import { AsyncLocalStorage } from 'async_hooks';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TicketPriority, TicketStatus, WebhookDeliveryStatus } from '@prisma/client';
import { PrismaService } from '../src/common/database/prisma.service';
import { AppClsStore } from '../src/common/context/app-cls.store';
import { AnalyticsMetricsService } from '../src/modules/analytics/services/analytics-metrics.service';
import { AnalyticsEventListener } from '../src/modules/analytics/listeners/analytics-event.listener';
import { EventsGateway } from '../src/modules/analytics/gateways/events.gateway';
import { WebhookDispatcherService } from '../src/modules/analytics/services/webhook-dispatcher.service';
import { Queue } from 'bullmq';
import { WEBHOOK_DISPATCHER_QUEUE } from '../src/modules/analytics/constants/webhook.constants';
import {
  TicketCreatedEvent,
  TicketTransitionedEvent,
} from '../src/common/events/ticket.events';

describe('CQRS Read Layer & Pre-Aggregated Redis Caching Integration', () => {
  let prisma: PrismaService;
  let redis: Redis;
  let cls: ClsService<AppClsStore>;
  let metricsService: AnalyticsMetricsService;
  let gateway: EventsGateway;
  let webhookQueue: Queue;
  let webhookService: WebhookDispatcherService;
  let listener: AnalyticsEventListener;

  let testTenantId: string;
  const testTenantSlug = `analytics-cqrs-${Date.now()}`;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();

    redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || 'redis_secret',
    });

    const als = new AsyncLocalStorage();
    cls = new ClsService<AppClsStore>(als);

    webhookQueue = new Queue(WEBHOOK_DISPATCHER_QUEUE, {
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || 'redis_secret',
      },
    });

    metricsService = new AnalyticsMetricsService(redis, prisma);
    gateway = new EventsGateway();
    webhookService = new WebhookDispatcherService(webhookQueue, prisma);
    listener = new AnalyticsEventListener(metricsService, gateway, webhookService);

    // Create test tenant
    const tenant = await prisma.tenant.create({
      data: {
        name: 'CQRS Analytics Tenant',
        slug: testTenantSlug,
      },
    });
    testTenantId = tenant.id;
  });

  afterAll(async () => {
    if (testTenantId) {
      await redis.del(`tenant:${testTenantId}:metrics:live`);
      await prisma.tenant.delete({
        where: { id: testTenantId },
      });
    }
    await webhookQueue.close();
    await redis.quit();
    await prisma.$disconnect();
  });

  it('guarantees sub-50ms latency for pre-aggregated dashboard reads and handles cache rebuild on miss', async () => {
    // 1. Ensure Redis cache is clean (cold start)
    await redis.del(`tenant:${testTenantId}:metrics:live`);

    // 2. Cold start: cache miss triggers rebuildLiveMetrics
    const rebuildStart = Date.now();
    const rebuiltMetrics = await metricsService.rebuildLiveMetrics(testTenantId);
    const rebuildDuration = Date.now() - rebuildStart;

    expect(rebuiltMetrics).toBeDefined();
    expect(rebuiltMetrics.source).toBe('CACHE_REBUILD_FALLBACK');
    console.log(`[CQRS LATENCY] Cold start cache rebuild duration: ${rebuildDuration}ms`);

    // 3. Warm read directly from Redis Hash
    const warmStart = Date.now();
    const liveMetrics = await metricsService.getLiveMetrics(testTenantId);
    const warmDuration = Date.now() - warmStart;

    console.log(`[CQRS LATENCY] Pre-aggregated Redis dashboard read duration: ${warmDuration}ms`);

    expect(liveMetrics).toBeDefined();
    expect(liveMetrics!.source).toBe('REDIS_PRE_AGGREGATED');
    // Guaranteed sub-50ms latency!
    expect(warmDuration).toBeLessThan(50);
  });

  it('asynchronously updates Redis live metrics atomically via HINCRBY on ticket lifecycle mutations', async () => {
    const redisKey = `tenant:${testTenantId}:metrics:live`;
    await metricsService.rebuildLiveMetrics(testTenantId);

    const initialMetrics = await metricsService.getLiveMetrics(testTenantId);
    const initialTotal = initialMetrics!.summary.totalTickets;
    const initialOpen = initialMetrics!.summary.openCount;
    const initialAssigned = initialMetrics!.summary.assignedCount;

    // 1. Simulate ticket.created event
    const ticketId = 'tck-cqrs-1';
    await listener.handleTicketCreated(
      new TicketCreatedEvent(
        testTenantId,
        ticketId,
        'TCK-CQRS-001',
        TicketPriority.URGENT,
        null,
        new Date(),
      ),
    );

    const afterCreate = await metricsService.getLiveMetrics(testTenantId);
    expect(afterCreate!.summary.totalTickets).toBe(initialTotal + 1);
    expect(afterCreate!.summary.openCount).toBe(initialOpen + 1);
    expect(afterCreate!.priorities.urgent).toBe(initialMetrics!.priorities.urgent + 1);

    // 2. Simulate ticket.transitioned (OPEN -> ASSIGNED)
    await listener.handleTicketTransitioned(
      new TicketTransitionedEvent(
        testTenantId,
        ticketId,
        TicketStatus.OPEN,
        TicketStatus.ASSIGNED,
        'agent-1',
        'Claimed',
      ),
    );

    const afterAssigned = await metricsService.getLiveMetrics(testTenantId);
    // Open count decremented by 1, assigned count incremented by 1
    expect(afterAssigned!.summary.openCount).toBe(initialOpen);
    expect(afterAssigned!.summary.assignedCount).toBe(initialAssigned + 1);

    // 3. Simulate ticket.transitioned (ASSIGNED -> ON_HOLD)
    await listener.handleTicketTransitioned(
      new TicketTransitionedEvent(
        testTenantId,
        ticketId,
        TicketStatus.ASSIGNED,
        TicketStatus.ON_HOLD,
        'agent-1',
        'Customer waiting',
      ),
    );

    const afterHold = await metricsService.getLiveMetrics(testTenantId);
    expect(afterHold!.summary.assignedCount).toBe(initialAssigned);
    expect(afterHold!.summary.onHoldCount).toBe(1);
  });

  it('proves outbound webhook subscription registration and Dead Letter Queue (DLQ) tracking', async () => {
    // 1. Create a webhook subscription
    const sub = await webhookService.createSubscription(testTenantId, {
      url: 'https://example-webhook-receiver.io/webhook',
      secret: 'super-secret-hmac-key',
      events: ['ticket.created', 'sla.breached'],
    });

    expect(sub.id).toBeDefined();
    expect(sub.isActive).toBe(true);

    // 2. Simulate DLQ delivery log creation
    const failedLog = await prisma.webhookDeliveryLog.create({
      data: {
        tenantId: testTenantId,
        subscriptionId: sub.id,
        event: 'sla.breached',
        payload: { ticketId: 'test-1', breached: true },
        status: WebhookDeliveryStatus.DEAD_LETTER,
        attempts: 5,
        lastError: 'HTTP 500: Internal Server Error',
      },
    });

    // 3. Inspect Dead Letter Queue for the tenant
    const dlq = await webhookService.getDeadLetterQueue(testTenantId);
    expect(dlq.length).toBeGreaterThanOrEqual(1);
    expect(dlq.some((d) => d.id === failedLog.id)).toBe(true);

    // 4. Retry DLQ delivery
    const retryResult = await webhookService.retryDeadLetterJob(failedLog.id, testTenantId);
    expect(retryResult.retried).toBe(true);

    const updatedLog = await prisma.webhookDeliveryLog.findUnique({
      where: { id: failedLog.id },
    });
    expect(updatedLog!.status).toBe(WebhookDeliveryStatus.PENDING_RETRY);
  });
});
