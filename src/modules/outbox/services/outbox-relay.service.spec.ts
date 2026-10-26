import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OutboxStatus, TicketPriority, TicketStatus } from '@prisma/client';
import { OutboxRelayService } from './outbox-relay.service';
import { PrismaService } from '../../../common/database/prisma.service';
import { SlaPolicyService } from '../../sla/services/sla-policy.service';
import { SlaCalendarCalculatorService } from '../../sla/services/sla-calendar-calculator.service';
import { TenantCalendarService } from '../../tenants/services/tenant-calendar.service';
import {
  SLA_JOB_BREACH,
  SLA_JOB_WARNING,
  SLA_MONITOR_QUEUE,
  getSlaBreachJobId,
  getSlaWarningJobId,
} from '../../sla/constants/sla.constants';
import {
  OUTBOX_EVENT_TICKET_CREATED,
  OUTBOX_EVENT_TICKET_STATUS_CHANGED,
  OUTBOX_EVENT_TICKET_CLAIMED,
} from '../outbox.constants';

describe('OutboxRelayService', () => {
  let service: OutboxRelayService;
  let mockPrisma: any;
  let mockQueue: jest.Mocked<Queue<any>>;
  let mockSlaPolicyService: any;
  let mockCalendarCalculator: any;
  let mockTenantCalendarService: any;
  let mockEventEmitter: any;
  let mockConfigService: any;

  const testTenantId = 'tenant-1111-uuid';
  const testTicketId = 'ticket-2222-uuid';

  beforeEach(async () => {
    mockQueue = {
      addBulk: jest.fn().mockResolvedValue([]),
      getJob: jest.fn().mockResolvedValue({ remove: jest.fn() }),
    } as unknown as jest.Mocked<Queue<any>>;

    mockPrisma = {
      $queryRaw: jest.fn(),
      $executeRaw: jest.fn().mockResolvedValue(1),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      ticket: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      ticketAuditLog: {
        create: jest.fn().mockResolvedValue({}),
      },
      outboxEvent: {
        update: jest.fn().mockResolvedValue({}),
      },
    };

    mockSlaPolicyService = {
      resolvePolicyForTicket: jest.fn().mockResolvedValue({
        id: 'policy-1',
        version: 1,
        priority: TicketPriority.HIGH,
        responseTimeMinutes: 30,
        resolutionTimeMinutes: 240,
      }),
    };

    mockCalendarCalculator = {
      calculateDeadlines: jest.fn().mockReturnValue({
        warningDate: new Date('2026-10-27T10:00:00Z'),
        breachDate: new Date('2026-10-27T12:00:00Z'),
        warningDelayMs: 3600000,
        breachDelayMs: 7200000,
        businessDurationMs: 14400000,
      }),
      calculateElapsedBusinessMs: jest.fn().mockReturnValue(1800000),
    };

    mockTenantCalendarService = {
      getTenantCalendarContext: jest.fn().mockResolvedValue({
        calendar: { timezone: 'UTC', weeklySchedule: {}, is24x7: false },
        holidays: [],
      }),
    };

    mockEventEmitter = {
      emit: jest.fn(),
    };

    mockConfigService = {
      get: jest.fn().mockReturnValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxRelayService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: `BullQueue_${SLA_MONITOR_QUEUE}`, useValue: mockQueue },
        { provide: SlaPolicyService, useValue: mockSlaPolicyService },
        { provide: SlaCalendarCalculatorService, useValue: mockCalendarCalculator },
        { provide: TenantCalendarService, useValue: mockTenantCalendarService },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<OutboxRelayService>(OutboxRelayService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('processes ticket.created outbox event and dispatches BullMQ jobs via addBulk()', async () => {
    mockPrisma.ticket.findUnique.mockResolvedValue({
      id: testTicketId,
      tenantId: testTenantId,
      priority: TicketPriority.HIGH,
      status: TicketStatus.OPEN,
      createdAt: new Date(),
    });

    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'outbox-1',
        tenant_id: testTenantId,
        aggregate_type: 'TICKET',
        aggregate_id: testTicketId,
        event_type: OUTBOX_EVENT_TICKET_CREATED,
        payload: {
          tenantId: testTenantId,
          ticketId: testTicketId,
          priority: TicketPriority.HIGH,
          status: TicketStatus.OPEN,
          createdAt: new Date().toISOString(),
        },
        retry_count: 0,
      },
    ]);

    const processed = await service.processPendingEvents();

    expect(processed).toBe(1);
    expect(mockQueue.addBulk).toHaveBeenCalledTimes(1);

    const queuedJobs = mockQueue.addBulk.mock.calls[0][0];
    expect(queuedJobs).toHaveLength(2);

    // Warning job with deterministic jobId
    expect(queuedJobs[0]!.name).toBe(SLA_JOB_WARNING);
    expect(queuedJobs[0]!.opts!.jobId).toBe(getSlaWarningJobId(testTenantId, testTicketId));
    expect(queuedJobs[0]!.opts!.delay).toBe(3600000);

    // Breach job with deterministic jobId
    expect(queuedJobs[1]!.name).toBe(SLA_JOB_BREACH);
    expect(queuedJobs[1]!.opts!.jobId).toBe(getSlaBreachJobId(testTenantId, testTicketId));
    expect(queuedJobs[1]!.opts!.delay).toBe(7200000);

    // Verified ticket deadline update and domain event emission
    expect(mockPrisma.ticket.update).toHaveBeenCalled();
    expect(mockEventEmitter.emit).toHaveBeenCalled();
  });

  it('handles SLA pause on ON_HOLD state change: cancels BullMQ jobs and updates remaining SLA', async () => {
    mockPrisma.ticket.findUnique.mockResolvedValue({
      id: testTicketId,
      tenantId: testTenantId,
      priority: TicketPriority.HIGH,
      status: TicketStatus.ON_HOLD,
      remainingSlaMs: BigInt(14400000),
      createdAt: new Date(),
      lastResumedAt: new Date(),
    });

    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'outbox-2',
        tenant_id: testTenantId,
        aggregate_type: 'TICKET',
        aggregate_id: testTicketId,
        event_type: OUTBOX_EVENT_TICKET_STATUS_CHANGED,
        payload: {
          tenantId: testTenantId,
          ticketId: testTicketId,
          previousStatus: TicketStatus.IN_PROGRESS,
          newStatus: TicketStatus.ON_HOLD,
          transitionedAt: new Date().toISOString(),
        },
        retry_count: 0,
      },
    ]);

    const processed = await service.processPendingEvents();

    expect(processed).toBe(1);
    expect(mockQueue.getJob).toHaveBeenCalledWith(getSlaWarningJobId(testTenantId, testTicketId));
    expect(mockQueue.getJob).toHaveBeenCalledWith(getSlaBreachJobId(testTenantId, testTicketId));

    // Ticket updated with remaining SLA and paused timestamp
    expect(mockPrisma.ticket.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: testTicketId },
        data: expect.objectContaining({
          slaPausedAt: expect.any(Date),
          remainingSlaMs: BigInt(12600000), // 14400000 - 1800000
        }),
      }),
    );
  });

  it('handles SLA resume on IN_PROGRESS state change: re-enqueues jobs via addBulk()', async () => {
    mockPrisma.ticket.findUnique.mockResolvedValue({
      id: testTicketId,
      tenantId: testTenantId,
      priority: TicketPriority.HIGH,
      status: TicketStatus.IN_PROGRESS,
      remainingSlaMs: BigInt(12600000),
      isBreached: false,
      isWarningSent: false,
      policyVersion: 1,
    });

    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'outbox-3',
        tenant_id: testTenantId,
        aggregate_type: 'TICKET',
        aggregate_id: testTicketId,
        event_type: OUTBOX_EVENT_TICKET_STATUS_CHANGED,
        payload: {
          tenantId: testTenantId,
          ticketId: testTicketId,
          previousStatus: TicketStatus.ON_HOLD,
          newStatus: TicketStatus.IN_PROGRESS,
          transitionedAt: new Date().toISOString(),
        },
        retry_count: 0,
      },
    ]);

    const processed = await service.processPendingEvents();

    expect(processed).toBe(1);
    expect(mockQueue.addBulk).toHaveBeenCalledTimes(1);

    const queuedJobs = mockQueue.addBulk.mock.calls[0][0];
    expect(queuedJobs.length).toBeGreaterThanOrEqual(1);

    expect(mockPrisma.ticket.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: testTicketId },
        data: expect.objectContaining({
          slaPausedAt: null,
          lastResumedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('retries with exponential backoff if Redis BullMQ fails temporarily', async () => {
    mockPrisma.ticket.findUnique.mockResolvedValue({
      id: testTicketId,
      tenantId: testTenantId,
      priority: TicketPriority.HIGH,
      status: TicketStatus.OPEN,
      createdAt: new Date(),
    });

    mockQueue.addBulk.mockRejectedValueOnce(new Error('ECONNREFUSED: Redis down'));

    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'outbox-fail-1',
        tenant_id: testTenantId,
        aggregate_type: 'TICKET',
        aggregate_id: testTicketId,
        event_type: OUTBOX_EVENT_TICKET_CREATED,
        payload: {
          tenantId: testTenantId,
          ticketId: testTicketId,
          priority: TicketPriority.HIGH,
          status: TicketStatus.OPEN,
          createdAt: new Date().toISOString(),
        },
        retry_count: 1,
      },
    ]);

    await service.processPendingEvents();

    // Verifies retry backoff (retry count incremented to 2, nextAttemptAt in future)
    expect(mockPrisma.outboxEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'outbox-fail-1' },
        data: expect.objectContaining({
          status: OutboxStatus.PENDING,
          retryCount: 2,
          nextAttemptAt: expect.any(Date),
          error: expect.stringContaining('ECONNREFUSED'),
        }),
      }),
    );
  });

  it('moves to DEAD_LETTER after 5 failed retry attempts', async () => {
    mockPrisma.ticket.findUnique.mockResolvedValue({
      id: testTicketId,
      tenantId: testTenantId,
      priority: TicketPriority.HIGH,
      status: TicketStatus.OPEN,
      createdAt: new Date(),
    });

    mockQueue.addBulk.mockRejectedValueOnce(new Error('Persistent serialization error'));

    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'outbox-dlq-1',
        tenant_id: testTenantId,
        aggregate_type: 'TICKET',
        aggregate_id: testTicketId,
        event_type: OUTBOX_EVENT_TICKET_CREATED,
        payload: {
          tenantId: testTenantId,
          ticketId: testTicketId,
          priority: TicketPriority.HIGH,
          status: TicketStatus.OPEN,
          createdAt: new Date().toISOString(),
        },
        retry_count: 4, // 4 + 1 = 5 (max retries reached)
      },
    ]);

    await service.processPendingEvents();

    expect(mockPrisma.outboxEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'outbox-dlq-1' },
        data: expect.objectContaining({
          status: OutboxStatus.DEAD_LETTER,
          retryCount: 5,
        }),
      }),
    );
  });
});
