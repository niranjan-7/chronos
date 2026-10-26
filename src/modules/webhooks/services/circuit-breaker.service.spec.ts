import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CircuitState } from '@prisma/client';
import { CircuitBreakerService } from './circuit-breaker.service';
import { REDIS_CLIENT } from '../../../common/database/redis.provider';
import { PrismaService } from '../../../common/database/prisma.service';
import {
  WEBHOOK_CIRCUIT_CLOSED_EVENT,
  WEBHOOK_CIRCUIT_TRIPPED_EVENT,
  WEBHOOK_SYSTEM_ALERT_EVENT,
} from '../constants/webhook.constants';

describe('CircuitBreakerService (Redis Sliding-Window Circuit Breaker)', () => {
  let service: CircuitBreakerService;
  let mockRedis: any;
  let mockPrisma: any;
  let mockEventEmitter: any;

  const tenantId = '00000000-0000-0000-0000-000000000001';
  const endpointId = '11111111-1111-1111-1111-111111111111';

  beforeEach(async () => {
    mockRedis = {
      mget: jest.fn(),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      pipeline: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnThis(),
        del: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      }),
    };

    mockPrisma = {
      webhookEndpoint: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    mockEventEmitter = {
      emit: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CircuitBreakerService,
        { provide: REDIS_CLIENT, useValue: mockRedis },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<CircuitBreakerService>(CircuitBreakerService);
  });

  describe('checkCircuit', () => {
    it('should allow normal execution when circuit is CLOSED (default state)', async () => {
      mockRedis.mget.mockResolvedValue([null, null]);

      const result = await service.checkCircuit(tenantId, endpointId);

      expect(result.state).toBe(CircuitState.CLOSED);
      expect(result.canExecute).toBe(true);
      expect(result.isProbe).toBe(false);
    });

    it('should fast-fail execution when circuit is OPEN and cooldown is active', async () => {
      const futureCooldown = Date.now() + 45000; // 45 seconds remaining
      mockRedis.mget.mockResolvedValue([CircuitState.OPEN, futureCooldown.toString()]);

      const result = await service.checkCircuit(tenantId, endpointId);

      expect(result.state).toBe(CircuitState.OPEN);
      expect(result.canExecute).toBe(false);
      expect(result.isProbe).toBe(false);
      expect(result.reason).toContain('Circuit is OPEN');
    });

    it('should transition to HALF_OPEN and allow probe request when cooldown expires and lock acquired', async () => {
      const pastCooldown = Date.now() - 5000; // expired 5 seconds ago
      mockRedis.mget.mockResolvedValue([CircuitState.OPEN, pastCooldown.toString()]);
      mockRedis.set.mockResolvedValue('OK'); // Probe lock acquired via SET NX

      const result = await service.checkCircuit(tenantId, endpointId);

      expect(result.state).toBe(CircuitState.HALF_OPEN);
      expect(result.canExecute).toBe(true);
      expect(result.isProbe).toBe(true);
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.stringContaining('probe_lock'),
        '1',
        'EX',
        30,
        'NX',
      );
    });

    it('should reject execution in HALF_OPEN if probe request is already in-flight (lock not acquired)', async () => {
      const pastCooldown = Date.now() - 5000;
      mockRedis.mget.mockResolvedValue([CircuitState.OPEN, pastCooldown.toString()]);
      mockRedis.set.mockResolvedValue(null); // Lock denied: another worker holds probe lock

      const result = await service.checkCircuit(tenantId, endpointId);

      expect(result.state).toBe(CircuitState.HALF_OPEN);
      expect(result.canExecute).toBe(false);
      expect(result.isProbe).toBe(false);
      expect(result.reason).toContain('Another probe request is currently in-flight');
    });
  });

  describe('recordFailure & Tripping Thresholds', () => {
    it('should ignore 4xx client errors from tripping the circuit breaker', async () => {
      await service.recordFailure(tenantId, endpointId, false, {
        statusCode: 400,
        errorMessage: 'HTTP 400: Bad Request',
      });

      expect(mockRedis.incr).not.toHaveBeenCalled();
    });

    it('should increment consecutive failures on 5xx or timeout errors', async () => {
      mockRedis.incr.mockResolvedValue(3);

      await service.recordFailure(tenantId, endpointId, false, {
        statusCode: 503,
        errorMessage: 'HTTP 503: Service Unavailable',
      });

      expect(mockRedis.incr).toHaveBeenCalled();
      expect(mockRedis.expire).toHaveBeenCalledWith(expect.any(String), 300); // 5-minute rolling window
    });

    it('should trip circuit to OPEN for 60s when failures reach 10 consecutive errors', async () => {
      mockRedis.incr.mockResolvedValue(10); // 10th failure

      await service.recordFailure(tenantId, endpointId, false, {
        isTimeout: true,
        errorMessage: 'Timeout error',
      });

      expect(mockPrisma.webhookEndpoint.updateMany).toHaveBeenCalledWith({
        where: { id: endpointId, tenantId },
        data: { circuitState: CircuitState.OPEN },
      });

      // Emits circuit tripped event and tenant system alert
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        WEBHOOK_CIRCUIT_TRIPPED_EVENT,
        expect.objectContaining({
          tenantId,
          endpointId,
          cooldownSeconds: 60,
        }),
      );

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        WEBHOOK_SYSTEM_ALERT_EVENT,
        expect.objectContaining({
          tenantId,
          endpointId,
          type: 'CIRCUIT_BREAKER_TRIPPED',
        }),
      );
    });

    it('should re-open circuit for 120s cooldown if a probe request fails in HALF_OPEN', async () => {
      await service.recordFailure(tenantId, endpointId, true, {
        statusCode: 500,
        errorMessage: 'HTTP 500: Internal Server Error',
      });

      expect(mockPrisma.webhookEndpoint.updateMany).toHaveBeenCalledWith({
        where: { id: endpointId, tenantId },
        data: { circuitState: CircuitState.OPEN },
      });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        WEBHOOK_CIRCUIT_TRIPPED_EVENT,
        expect.objectContaining({
          tenantId,
          endpointId,
          cooldownSeconds: 120, // 120s cooldown on probe failure
        }),
      );
    });
  });

  describe('recordSuccess & Reset Logic', () => {
    it('should reset failure counter on successful 2xx delivery in CLOSED state', async () => {
      await service.recordSuccess(tenantId, endpointId, false);

      expect(mockRedis.del).toHaveBeenCalledWith(expect.stringContaining('failures'));
    });

    it('should reset circuit to CLOSED and emit circuit closed event when probe succeeds', async () => {
      await service.recordSuccess(tenantId, endpointId, true);

      expect(mockPrisma.webhookEndpoint.updateMany).toHaveBeenCalledWith({
        where: { id: endpointId, tenantId },
        data: { circuitState: CircuitState.CLOSED },
      });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        WEBHOOK_CIRCUIT_CLOSED_EVENT,
        expect.objectContaining({
          tenantId,
          endpointId,
        }),
      );
    });
  });

  describe('resetCircuit', () => {
    it('should manually reset circuit state to CLOSED in Redis and database', async () => {
      await service.resetCircuit(tenantId, endpointId);

      expect(mockPrisma.webhookEndpoint.updateMany).toHaveBeenCalledWith({
        where: { id: endpointId, tenantId },
        data: { circuitState: CircuitState.CLOSED },
      });
    });
  });
});
