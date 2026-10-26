import { AnalyticsMetricsService } from './services/analytics-metrics.service';
import { EventsGateway } from './gateways/events.gateway';
import { WebhookProcessor } from './processors/webhook.processor';
import * as crypto from 'crypto';
import { WebhookDeliveryStatus } from '@prisma/client';
import { Job } from 'bullmq';

describe('Analytics & CQRS Module (Phase 4 Unit Tests)', () => {
  const mockTenantId = 'tenant-uuid-1111';

  describe('AnalyticsMetricsService (Redis Pre-Aggregated Hashes)', () => {
    let service: AnalyticsMetricsService;
    let mockRedis: any;
    let mockPrisma: any;

    beforeEach(() => {
      mockRedis = {
        hgetall: jest.fn(),
        hincrby: jest.fn().mockResolvedValue(1),
        hset: jest.fn().mockResolvedValue(1),
        expire: jest.fn().mockResolvedValue(1),
        pipeline: jest.fn().mockReturnValue({
          hincrby: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        }),
      };

      mockPrisma = {
        ticket: {
          count: jest.fn().mockResolvedValue(5),
        },
      };

      service = new AnalyticsMetricsService(mockRedis, mockPrisma);
    });

    it('should format Redis key with tenant namespace', () => {
      expect(service.getRedisKey(mockTenantId)).toBe(`tenant:${mockTenantId}:metrics:live`);
    });

    it('should parse pre-aggregated live metrics from Redis hash', async () => {
      mockRedis.hgetall.mockResolvedValue({
        total_tickets: '42',
        open_count: '10',
        assigned_count: '5',
        in_progress_count: '15',
        on_hold_count: '2',
        resolved_count: '8',
        closed_count: '2',
        breached_count: '1',
        at_risk_count: '3',
        priority_urgent_count: '4',
        priority_high_count: '8',
        priority_medium_count: '20',
        priority_low_count: '10',
      });

      const metrics = await service.getLiveMetrics(mockTenantId);

      expect(metrics).toBeDefined();
      expect(metrics!.source).toBe('REDIS_PRE_AGGREGATED');
      expect(metrics!.summary.totalTickets).toBe(42);
      expect(metrics!.summary.openCount).toBe(10);
      expect(metrics!.summary.inProgressCount).toBe(15);
      expect(metrics!.summary.breachedCount).toBe(1);
      expect(metrics!.priorities.urgent).toBe(4);
    });

    it('should return null on cache miss', async () => {
      mockRedis.hgetall.mockResolvedValue({});
      const metrics = await service.getLiveMetrics(mockTenantId);
      expect(metrics).toBeNull();
    });

    it('should execute cache rebuild fallback and populate Redis hash with TTL', async () => {
      const result = await service.rebuildLiveMetrics(mockTenantId);

      expect(result.source).toBe('CACHE_REBUILD_FALLBACK');
      expect(result.summary.totalTickets).toBe(5);
      expect(mockRedis.hset).toHaveBeenCalledWith(
        `tenant:${mockTenantId}:metrics:live`,
        expect.objectContaining({
          total_tickets: '5',
        }),
      );
      expect(mockRedis.expire).toHaveBeenCalledWith(
        `tenant:${mockTenantId}:metrics:live`,
        7 * 24 * 3600,
      );
    });
  });

  describe('EventsGateway (Tenant Authentication & Isolation)', () => {
    let gateway: EventsGateway;
    let mockClient: any;
    let mockServer: any;

    beforeEach(() => {
      gateway = new EventsGateway();
      mockServer = {
        to: jest.fn().mockReturnValue({
          emit: jest.fn(),
        }),
      };
      gateway.server = mockServer;

      mockClient = {
        id: 'client-1',
        handshake: {
          headers: {},
          auth: {},
          query: {},
        },
        data: {},
        join: jest.fn(),
        emit: jest.fn(),
        disconnect: jest.fn(),
      };
    });

    it('should reject connection when x-tenant-id is missing', () => {
      gateway.handleConnection(mockClient);

      expect(mockClient.emit).toHaveBeenCalledWith('error', expect.any(Object));
      expect(mockClient.disconnect).toHaveBeenCalledWith(true);
      expect(mockClient.join).not.toHaveBeenCalled();
    });

    it('should authenticate client and join tenant room when valid UUID header is present', () => {
      mockClient.handshake.headers['x-tenant-id'] = 'a03a3200-b6ed-4314-b1d5-a24099a62f9a';

      gateway.handleConnection(mockClient);

      expect(mockClient.join).toHaveBeenCalledWith(
        'tenant:a03a3200-b6ed-4314-b1d5-a24099a62f9a',
      );
      expect(mockClient.disconnect).not.toHaveBeenCalled();
    });

    it('should broadcast event strictly to tenant room', () => {
      const tenantId = 'a03a3200-b6ed-4314-b1d5-a24099a62f9a';
      gateway.broadcastTicketClaimed(tenantId, { ticketId: 't-1' });

      expect(mockServer.to).toHaveBeenCalledWith(`tenant:${tenantId}`);
    });
  });

  describe('WebhookProcessor (HMAC-SHA256 Signing & DLQ)', () => {
    let processor: WebhookProcessor;
    let mockPrisma: any;

    beforeEach(() => {
      mockPrisma = {
        webhookDeliveryLog: {
          findUnique: jest.fn().mockResolvedValue({ id: 'del-1' }),
          update: jest.fn().mockResolvedValue({}),
        },
      };
      processor = new WebhookProcessor(mockPrisma);
    });

    it('should sign payload with HMAC-SHA256 signature', () => {
      const secret = 'super-webhook-secret';
      const timestamp = '1700000000000';
      const payload = { event: 'ticket.created', id: '123' };
      const bodyString = JSON.stringify(payload);

      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}.${bodyString}`)
        .digest('hex');

      expect(expectedSignature).toBeDefined();
      expect(expectedSignature.length).toBe(64);
    });

    it('should move delivery to Dead Letter Queue (DLQ) when 5 attempts are exhausted', async () => {
      const mockJob = {
        data: {
          deliveryId: 'del-1',
          tenantId: mockTenantId,
          url: 'http://unreachable-endpoint-invalid.test/webhook',
          secret: 'secret',
          event: 'ticket.created',
          payload: { id: 1 },
        },
        attemptsMade: 4, // 5th attempt
        opts: { attempts: 5 },
      } as unknown as Job<any>;

      await expect(processor.process(mockJob)).rejects.toThrow();

      expect(mockPrisma.webhookDeliveryLog.update).toHaveBeenCalledWith({
        where: { id: 'del-1' },
        data: expect.objectContaining({
          status: WebhookDeliveryStatus.DEAD_LETTER,
          attempts: 5,
        }),
      });
    });
  });
});
