import * as http from 'http';
import Redis from 'ioredis';
import { AsyncLocalStorage } from 'async_hooks';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { CircuitState, WebhookDeliveryStatus } from '@prisma/client';
import { PrismaService } from '../src/common/database/prisma.service';
import { AppClsStore } from '../src/common/context/app-cls.store';
import { WebhookCryptoService } from '../src/modules/webhooks/services/webhook-crypto.service';
import { CircuitBreakerService } from '../src/modules/webhooks/services/circuit-breaker.service';
import { WebhookDispatcherService } from '../src/modules/webhooks/services/webhook-dispatcher.service';
import { WebhookProcessor } from '../src/modules/webhooks/processors/webhook.processor';
import { WEBHOOK_DISPATCHER_QUEUE } from '../src/modules/webhooks/constants/webhook.constants';
import { WebhookJobPayload } from '../src/modules/webhooks/interfaces/webhook-job-payload.interface';

describe('Phase 8: Enterprise Outbound Webhooks Integration (HMAC-SHA256, Jitter, Circuit Breaker & DLQ)', () => {
  let prisma: PrismaService;
  let redis: Redis;
  let cls: ClsService<AppClsStore>;
  let queue: Queue<WebhookJobPayload>;
  let cryptoService: WebhookCryptoService;
  let circuitBreakerService: CircuitBreakerService;
  let dispatcherService: WebhookDispatcherService;
  let processor: WebhookProcessor;
  let eventEmitter: EventEmitter2;

  let testTenantId: string;
  const testTenantSlug = `webhooks-integ-${Date.now()}`;

  // Ephemeral test HTTP receiver
  let mockServer: http.Server;
  let mockServerPort: number;
  let mockServerUrl: string;

  let lastReceivedHeaders: http.IncomingHttpHeaders = {};
  let lastReceivedBody = '';
  let mockResponseStatusCode = 200;
  let mockResponseDelayMs = 0;
  let totalMockRequestsReceived = 0;

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

    const config = new ConfigService();
    eventEmitter = new EventEmitter2();

    queue = new Queue<WebhookJobPayload>(WEBHOOK_DISPATCHER_QUEUE, {
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || 'redis_secret',
      },
    });

    cryptoService = new WebhookCryptoService(config);
    circuitBreakerService = new CircuitBreakerService(redis, prisma, eventEmitter);
    dispatcherService = new WebhookDispatcherService(
      queue,
      prisma,
      cryptoService,
      circuitBreakerService,
    );
    processor = new WebhookProcessor(prisma, cryptoService, circuitBreakerService);

    // Setup ephemeral HTTP server to receive webhook dispatches
    await new Promise<void>((resolve) => {
      mockServer = http.createServer(async (req, res) => {
        totalMockRequestsReceived++;
        lastReceivedHeaders = req.headers;
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', async () => {
          lastReceivedBody = body;
          if (mockResponseDelayMs > 0) {
            await new Promise((r) => setTimeout(r, mockResponseDelayMs));
          }
          res.writeHead(mockResponseStatusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: true, status: mockResponseStatusCode }));
        });
      });

      mockServer.listen(0, '127.0.0.1', () => {
        const addr = mockServer.address() as any;
        mockServerPort = addr.port;
        mockServerUrl = `http://127.0.0.1:${mockServerPort}/webhook`;
        resolve();
      });
    });

    // Create test tenant
    const tenant = await prisma.tenant.create({
      data: {
        name: 'Enterprise Webhook Test Tenant',
        slug: testTenantSlug,
      },
    });
    testTenantId = tenant.id;
  });

  afterAll(async () => {
    if (mockServer) {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
    // Clean up Redis keys for test tenant
    const keys = await redis.keys(`tenant:${testTenantId}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    if (testTenantId) {
      await prisma.tenant.delete({
        where: { id: testTenantId },
      });
    }
    await queue.close();
    await redis.quit();
    await prisma.$disconnect();
  });

  it('1. provisions WebhookEndpoint with AES-256-GCM secret encryption at rest', async () => {
    const rawSecret = 'whsec_slack_production_token_12345';
    const endpoint = await dispatcherService.createEndpoint(testTenantId, {
      url: mockServerUrl,
      signingSecret: rawSecret,
      subscribedEvents: ['sla.warning', 'sla.breach', 'ticket.escalated'],
    });

    expect(endpoint.id).toBeDefined();
    expect(endpoint.url).toBe(mockServerUrl);
    expect(endpoint.circuitState).toBe(CircuitState.CLOSED);

    // Verify secret is encrypted in database
    const dbRecord = await prisma.webhookEndpoint.findUnique({
      where: { id: endpoint.id },
    });
    expect(dbRecord!.signingSecret).toBeDefined();
    expect(dbRecord!.signingSecret.startsWith('enc:v1:')).toBe(true);

    // Verify decryption restores exact original raw secret
    const decrypted = cryptoService.decryptSecret(dbRecord!.signingSecret);
    expect(decrypted).toBe(rawSecret);
  });

  it('2. cryptographically signs outbound HTTP request with X-Chronos-Signature & Idempotency Delivery ID', async () => {
    mockResponseStatusCode = 200;
    mockResponseDelayMs = 0;

    const rawSecret = 'whsec_signature_test_key_abc';
    const endpoint = await dispatcherService.createEndpoint(testTenantId, {
      url: mockServerUrl,
      signingSecret: rawSecret,
      subscribedEvents: ['sla.warning'],
    });

    const payload = {
      event: 'sla.warning',
      ticketId: 'tck-12345',
      ticketNumber: 'TCK-000099',
      stage: 'WARNING_80_PERCENT',
      remainingMs: 720000,
    };

    // Dispatch event
    const count = await dispatcherService.dispatchEvent(testTenantId, 'sla.warning', payload);
    expect(count).toBeGreaterThanOrEqual(1);

    // Find created delivery attempt in DB
    const attempt = await prisma.webhookDeliveryAttempt.findFirst({
      where: { tenantId: testTenantId, endpointId: endpoint.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(attempt).toBeDefined();

    // Process job with WebhookProcessor
    const mockJob = {
      data: {
        deliveryId: attempt!.id,
        endpointId: endpoint.id,
        tenantId: testTenantId,
        url: endpoint.url,
        secret: endpoint.signingSecret,
        event: 'sla.warning',
        payload,
      },
      attemptsMade: 0,
      opts: { attempts: 5 },
    } as any;

    const result = await processor.process(mockJob);
    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);

    // Assert mock server received cryptographic headers
    expect(lastReceivedHeaders['x-chronos-signature']).toBeDefined();
    expect(lastReceivedHeaders['x-chronos-delivery-id']).toBe(attempt!.id);
    expect(lastReceivedHeaders['x-chronos-event']).toBe('sla.warning');
    expect(lastReceivedHeaders['x-chronos-tenant']).toBe(testTenantId);

    // Verify HMAC signature validity against raw body
    const isValidSignature = cryptoService.verifySignature(
      lastReceivedHeaders['x-chronos-signature'] as string,
      lastReceivedBody,
      rawSecret,
      300,
    );
    expect(isValidSignature).toBe(true);

    // Verify attempt in DB updated to SUCCESS with recorded latency
    const updatedAttempt = await prisma.webhookDeliveryAttempt.findUnique({
      where: { id: attempt!.id },
    });
    expect(updatedAttempt!.status).toBe(WebhookDeliveryStatus.SUCCESS);
    expect(updatedAttempt!.statusCode).toBe(200);
    expect(updatedAttempt!.responseLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('3. trips sliding-window circuit breaker after 10 consecutive failures and fast-fails without HTTP calls', async () => {
    const endpoint = await dispatcherService.createEndpoint(testTenantId, {
      url: mockServerUrl,
      signingSecret: 'whsec_cb_test',
      subscribedEvents: ['sla.breach'],
    });

    // 1. Simulate 9 consecutive 503 errors (below threshold)
    for (let i = 1; i <= 9; i++) {
      await circuitBreakerService.recordFailure(testTenantId, endpoint.id, false, {
        statusCode: 503,
        errorMessage: 'HTTP 503 Service Unavailable',
      });
    }

    const preTripStatus = await circuitBreakerService.getCircuitStatus(testTenantId, endpoint.id);
    expect(preTripStatus.state).toBe(CircuitState.CLOSED);
    expect(preTripStatus.consecutiveFailures).toBe(9);

    // 2. 10th failure -> Trips circuit to OPEN for 60s
    await circuitBreakerService.recordFailure(testTenantId, endpoint.id, false, {
      statusCode: 500,
      errorMessage: 'HTTP 500 Internal Server Error',
    });

    const postTripStatus = await circuitBreakerService.getCircuitStatus(testTenantId, endpoint.id);
    expect(postTripStatus.state).toBe(CircuitState.OPEN);
    expect(postTripStatus.cooldownSeconds).toBe(60);

    // Verify endpoint in PostgreSQL is marked OPEN
    const dbEndpoint = await prisma.webhookEndpoint.findUnique({
      where: { id: endpoint.id },
    });
    expect(dbEndpoint!.circuitState).toBe(CircuitState.OPEN);

    // 3. Fast-Fail Proof: Attempting a dispatch in OPEN state does NOT invoke HTTP server
    const requestsBeforeFastFail = totalMockRequestsReceived;

    const fastFailAttempt = await prisma.webhookDeliveryAttempt.create({
      data: {
        tenantId: testTenantId,
        endpointId: endpoint.id,
        event: 'sla.breach',
        payload: { breach: true },
        status: WebhookDeliveryStatus.PENDING_RETRY,
      },
    });

    const fastFailJob = {
      data: {
        deliveryId: fastFailAttempt.id,
        endpointId: endpoint.id,
        tenantId: testTenantId,
        url: endpoint.url,
        secret: endpoint.signingSecret,
        event: 'sla.breach',
        payload: { breach: true },
      },
      attemptsMade: 0,
      opts: { attempts: 5 },
    } as any;

    await expect(processor.process(fastFailJob)).rejects.toThrow(/CircuitBreakerFastFail/);

    // ZERO HTTP requests reached the server (fast-failed locally in Redis)
    expect(totalMockRequestsReceived).toBe(requestsBeforeFastFail);

    // Verify attempt recorded 0ms latency and OPEN circuit state
    const recordedFastFail = await prisma.webhookDeliveryAttempt.findUnique({
      where: { id: fastFailAttempt.id },
    });
    expect(recordedFastFail!.responseLatencyMs).toBe(0);
    expect(recordedFastFail!.circuitStateAtDispatch).toBe(CircuitState.OPEN);
  });

  it('4. allows probe request in HALF_OPEN after cooldown expires and resets circuit on 2xx', async () => {
    const endpoint = await dispatcherService.createEndpoint(testTenantId, {
      url: mockServerUrl,
      signingSecret: 'whsec_probe_test',
      subscribedEvents: ['ticket.escalated'],
    });

    // Manually trip circuit to OPEN
    await circuitBreakerService.tripCircuit(testTenantId, endpoint.id, 60, 'Simulated trip');

    // Simulate cooldown expiry in Redis (set open_until in past)
    const openUntilKey = `tenant:${testTenantId}:webhook:${endpoint.id}:circuit:open_until`;
    await redis.set(openUntilKey, (Date.now() - 1000).toString());

    // Next check should transition to HALF_OPEN and acquire probe lock
    const check = await circuitBreakerService.checkCircuit(testTenantId, endpoint.id);
    expect(check.state).toBe(CircuitState.HALF_OPEN);
    expect(check.canExecute).toBe(true);
    expect(check.isProbe).toBe(true);

    // Concurrent second check should fail lock (single probe concurrency guarantee)
    const concurrentCheck = await circuitBreakerService.checkCircuit(testTenantId, endpoint.id);
    expect(concurrentCheck.state).toBe(CircuitState.HALF_OPEN);
    expect(concurrentCheck.canExecute).toBe(false);
    expect(concurrentCheck.reason).toContain('Another probe request is currently in-flight');

    // Probe returns 2xx -> Resets circuit to CLOSED
    await circuitBreakerService.recordSuccess(testTenantId, endpoint.id, true);

    const resetStatus = await circuitBreakerService.getCircuitStatus(testTenantId, endpoint.id);
    expect(resetStatus.state).toBe(CircuitState.CLOSED);

    const dbEndpoint = await prisma.webhookEndpoint.findUnique({
      where: { id: endpoint.id },
    });
    expect(dbEndpoint!.circuitState).toBe(CircuitState.CLOSED);
  });

  it('5. dead-letters permanently failed deliveries and supports single & bulk replay APIs', async () => {
    const endpoint = await dispatcherService.createEndpoint(testTenantId, {
      url: mockServerUrl,
      signingSecret: 'whsec_dlq_test',
    });

    // Create 2 dead-letter deliveries
    const dlq1 = await prisma.webhookDeliveryAttempt.create({
      data: {
        tenantId: testTenantId,
        endpointId: endpoint.id,
        event: 'sla.breach',
        payload: { error: 'down' },
        status: WebhookDeliveryStatus.DEAD_LETTER,
        attemptNumber: 5,
        errorMessage: 'Max attempts exhausted. Terminal error.',
      },
    });

    const dlq2 = await prisma.webhookDeliveryAttempt.create({
      data: {
        tenantId: testTenantId,
        endpointId: endpoint.id,
        event: 'sla.breach',
        payload: { error: 'down 2' },
        status: WebhookDeliveryStatus.DEAD_LETTER,
        attemptNumber: 5,
        errorMessage: 'Max attempts exhausted. Terminal error.',
      },
    });

    // 1. Verify DLQ query API
    const dlqList = await dispatcherService.getDeadLetterQueue(testTenantId);
    expect(dlqList.some((d) => d.id === dlq1.id)).toBe(true);
    expect(dlqList.some((d) => d.id === dlq2.id)).toBe(true);

    // 2. Replay single delivery API
    const replaySingle = await dispatcherService.replayDeadLetterDelivery(testTenantId, dlq1.id);
    expect(replaySingle.replayed).toBe(true);

    const refreshedDlq1 = await prisma.webhookDeliveryAttempt.findUnique({
      where: { id: dlq1.id },
    });
    expect(refreshedDlq1!.status).toBe(WebhookDeliveryStatus.PENDING_RETRY);
    expect(refreshedDlq1!.attemptNumber).toBe(0);

    // 3. Replay all endpoint failures API
    const replayAll = await dispatcherService.replayAllEndpointFailures(testTenantId, endpoint.id);
    expect(replayAll.replayedCount).toBe(1); // dlq2 was remaining in DEAD_LETTER

    const refreshedDlq2 = await prisma.webhookDeliveryAttempt.findUnique({
      where: { id: dlq2.id },
    });
    expect(refreshedDlq2!.status).toBe(WebhookDeliveryStatus.PENDING_RETRY);
  });
});
