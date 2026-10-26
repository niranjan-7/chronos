import { Test, TestingModule } from '@nestjs/testing';
import { Queue, Job } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { TicketPriority, TicketStatus } from '@prisma/client';
import { SlaQueueService } from './services/sla-queue.service';
import { SlaPolicyService } from './services/sla-policy.service';
import { SlaCalendarCalculatorService } from './services/sla-calendar-calculator.service';
import { SlaEventListener } from './listeners/sla-event.listener';
import { SlaProcessor } from './processors/sla.processor';
import { PrismaService } from '../../common/database/prisma.service';
import { AppClsStore } from '../../common/context/app-cls.store';
import {
  SLA_JOB_BREACH,
  SLA_JOB_WARNING,
  SLA_MONITOR_QUEUE,
  getSlaBreachJobId,
  getSlaWarningJobId,
} from './constants/sla.constants';
import {
  TicketCreatedEvent,
  TicketTransitionedEvent,
} from '../../common/events/ticket.events';
import { SlaJobPayload } from './interfaces/sla-job-payload.interface';

describe('SLA Orchestration Engine (Phase 3)', () => {
  let queueService: SlaQueueService;
  let eventListener: SlaEventListener;
  let processor: SlaProcessor;
  let mockQueue: jest.Mocked<Queue<any>>;
  let mockPrisma: any;
  let mockCls: jest.Mocked<ClsService<AppClsStore>>;

  const mockTenantId = 'tenant-uuid-1111';
  const mockTicketId = 'ticket-uuid-2222';

  beforeEach(() => {
    mockQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
      getJob: jest.fn(),
    } as unknown as jest.Mocked<Queue<any>>;

    mockPrisma = {
      slaPolicy: {
        findFirst: jest.fn(),
        count: jest.fn().mockResolvedValue(1),
      },
      ticket: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      ticketAuditLog: {
        create: jest.fn().mockResolvedValue({}),
      },
    };

    mockCls = {
      runWith: jest.fn().mockImplementation((_store, cb) => cb()),
      get: jest.fn(),
      set: jest.fn(),
    } as unknown as jest.Mocked<ClsService<AppClsStore>>;

    queueService = new SlaQueueService(mockQueue);
    const policyService = new SlaPolicyService(mockPrisma);
    const calendarCalculator = new SlaCalendarCalculatorService();
    const mockTenantCalendar = {
      getTenantCalendarContext: jest.fn().mockResolvedValue({
        calendar: {
          timezone: 'UTC',
          weeklySchedule: {
            monday: [{ start: '00:00', end: '23:59' }],
            tuesday: [{ start: '00:00', end: '23:59' }],
            wednesday: [{ start: '00:00', end: '23:59' }],
            thursday: [{ start: '00:00', end: '23:59' }],
            friday: [{ start: '00:00', end: '23:59' }],
            saturday: [{ start: '00:00', end: '23:59' }],
            sunday: [{ start: '00:00', end: '23:59' }],
          },
          is24x7: true,
        },
        holidays: [],
      }),
    } as any;
    eventListener = new SlaEventListener(
      mockPrisma,
      policyService,
      queueService,
      calendarCalculator,
      mockTenantCalendar,
    );
    const mockEventEmitter = {
      emit: jest.fn(),
    } as any;
    processor = new SlaProcessor(mockPrisma, mockCls, mockEventEmitter);
  });

  describe('Deterministic Job IDs & SlaQueueService', () => {
    it('should generate deterministic job IDs for O(1) lookup', () => {
      expect(getSlaWarningJobId(mockTenantId, mockTicketId)).toBe(
        `sla-warn-${mockTenantId}-${mockTicketId}`,
      );
      expect(getSlaBreachJobId(mockTenantId, mockTicketId)).toBe(
        `sla-breach-${mockTenantId}-${mockTicketId}`,
      );
    });

    it('should schedule BullMQ warning at 80% and breach at 100% of target duration', async () => {
      // 60 minutes = 3,600,000 ms
      const durationMs = 3600000;

      const { warningJobId, breachJobId } = await queueService.scheduleSlaJobs({
        tenantId: mockTenantId,
        ticketId: mockTicketId,
        policyVersion: 1,
        targetDurationMs: durationMs,
      });

      expect(warningJobId).toBe(`sla-warn-${mockTenantId}-${mockTicketId}`);
      expect(breachJobId).toBe(`sla-breach-${mockTenantId}-${mockTicketId}`);

      // Warning at 80%: 2,880,000 ms
      expect(mockQueue.add).toHaveBeenCalledWith(
        SLA_JOB_WARNING,
        expect.objectContaining({ stage: 'WARNING' }),
        expect.objectContaining({
          jobId: warningJobId,
          delay: 2880000,
        }),
      );

      // Breach at 100%: 3,600,000 ms
      expect(mockQueue.add).toHaveBeenCalledWith(
        SLA_JOB_BREACH,
        expect.objectContaining({ stage: 'BREACH' }),
        expect.objectContaining({
          jobId: breachJobId,
          delay: 3600000,
        }),
      );
    });

    it('should cancel pending jobs in O(1) time without scanning queue', async () => {
      const mockJob = { remove: jest.fn().mockResolvedValue(undefined) };
      mockQueue.getJob.mockResolvedValue(mockJob as any);

      await queueService.cancelSlaJobs(mockTenantId, mockTicketId);

      expect(mockQueue.getJob).toHaveBeenCalledWith(`sla-warn-${mockTenantId}-${mockTicketId}`);
      expect(mockQueue.getJob).toHaveBeenCalledWith(`sla-breach-${mockTenantId}-${mockTicketId}`);
      expect(mockJob.remove).toHaveBeenCalledTimes(2);
    });
  });

  describe('SLA Pause & Resume Lifecycle (SlaEventListener)', () => {
    it('should calculate remaining_sla_ms and cancel BullMQ jobs on transition to ON_HOLD', async () => {
      const futureDue = new Date(Date.now() + 1800000); // 30 min remaining
      const now = new Date();
      mockPrisma.ticket.findUnique.mockResolvedValue({
        id: mockTicketId,
        tenantId: mockTenantId,
        status: TicketStatus.IN_PROGRESS,
        resolutionDueAt: futureDue,
        createdAt: now,
        lastResumedAt: now,
        isBreached: false,
      });

      const cancelSpy = jest.spyOn(queueService, 'cancelSlaJobs').mockResolvedValue();

      await eventListener.handleTicketTransitioned(
        new TicketTransitionedEvent(
          mockTenantId,
          mockTicketId,
          TicketStatus.IN_PROGRESS,
          TicketStatus.ON_HOLD,
        ),
      );

      expect(cancelSpy).toHaveBeenCalledWith(mockTenantId, mockTicketId);
      expect(mockPrisma.ticket.update).toHaveBeenCalledWith({
        where: { id: mockTicketId },
        data: expect.objectContaining({
          pausedAt: expect.any(Date),
          remainingSlaMs: expect.any(BigInt),
        }),
      });
      expect(mockPrisma.ticketAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'SLA_PAUSED',
        }),
      });
    });

    it('should re-enqueue BullMQ delayed job with remaining_sla_ms on transition back to IN_PROGRESS', async () => {
      mockPrisma.ticket.findUnique.mockResolvedValue({
        id: mockTicketId,
        tenantId: mockTenantId,
        status: TicketStatus.ON_HOLD,
        remainingSlaMs: BigInt(1800000), // 30 mins
        isBreached: false,
        isWarningSent: false,
        policyVersion: 1,
      });

      const scheduleSpy = jest.spyOn(queueService, 'scheduleJobsWithDelays').mockResolvedValue({
        warningJobId: 'w-1',
        breachJobId: 'b-1',
      });

      await eventListener.handleTicketTransitioned(
        new TicketTransitionedEvent(
          mockTenantId,
          mockTicketId,
          TicketStatus.ON_HOLD,
          TicketStatus.IN_PROGRESS,
        ),
      );

      expect(scheduleSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: mockTenantId,
          ticketId: mockTicketId,
        }),
      );
      expect(mockPrisma.ticket.update).toHaveBeenCalledWith({
        where: { id: mockTicketId },
        data: expect.objectContaining({
          pausedAt: null,
          resolutionDueAt: expect.any(Date),
        }),
      });
      expect(mockPrisma.ticketAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'SLA_RESUMED',
        }),
      });
    });

    it('should cancel and clean up pending SLA jobs on RESOLVED transition', async () => {
      mockPrisma.ticket.findUnique.mockResolvedValue({
        id: mockTicketId,
        tenantId: mockTenantId,
        status: TicketStatus.IN_PROGRESS,
      });

      const cancelSpy = jest.spyOn(queueService, 'cancelSlaJobs').mockResolvedValue();

      await eventListener.handleTicketTransitioned(
        new TicketTransitionedEvent(
          mockTenantId,
          mockTicketId,
          TicketStatus.IN_PROGRESS,
          TicketStatus.RESOLVED,
        ),
      );

      expect(cancelSpy).toHaveBeenCalledWith(mockTenantId, mockTicketId);
      expect(mockPrisma.ticketAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'SLA_RESOLVED_CLEANUP',
        }),
      });
    });
  });

  describe('SlaProcessor BullMQ Worker & Context Re-hydration', () => {
    it('should re-hydrate CLS tenantId before executing breach escalation', async () => {
      const mockJob = {
        id: 'job-123',
        name: SLA_JOB_BREACH,
        data: {
          tenantId: mockTenantId,
          ticketId: mockTicketId,
          policyVersion: 1,
          targetDeadline: new Date().toISOString(),
          stage: 'BREACH',
        } as SlaJobPayload,
      } as Job<SlaJobPayload>;

      mockPrisma.ticket.findFirst.mockResolvedValue({
        id: mockTicketId,
        tenantId: mockTenantId,
        status: TicketStatus.IN_PROGRESS,
        priority: TicketPriority.MEDIUM,
        isBreached: false,
        ticketNumber: 'TCK-000010',
      });

      const result = await processor.process(mockJob);

      // Verify CLS context was re-hydrated with the job tenantId
      expect(mockCls.runWith).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: mockTenantId,
          isSystemOperation: true,
        }),
        expect.any(Function),
      );

      // Verify DB marked isBreached = true and priority bumped MEDIUM -> HIGH
      expect(mockPrisma.ticket.update).toHaveBeenCalledWith({
        where: { id: mockTicketId },
        data: {
          isBreached: true,
          priority: TicketPriority.HIGH,
        },
      });

      // Verify audit log
      expect(mockPrisma.ticketAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'SLA_BREACH_TRIGGERED',
          changes: {
            isBreached: true,
            priority: { from: TicketPriority.MEDIUM, to: TicketPriority.HIGH },
          },
        }),
      });

      expect(result).toEqual(
        expect.objectContaining({
          processed: true,
          stage: 'BREACH',
          escalatedPriority: TicketPriority.HIGH,
        }),
      );
    });

    it('should mark isWarningSent = true on SLA warning job', async () => {
      const mockJob = {
        id: 'job-warn-1',
        name: SLA_JOB_WARNING,
        data: {
          tenantId: mockTenantId,
          ticketId: mockTicketId,
          policyVersion: 1,
          targetDeadline: new Date().toISOString(),
          stage: 'WARNING',
        } as SlaJobPayload,
      } as Job<SlaJobPayload>;

      mockPrisma.ticket.findFirst.mockResolvedValue({
        id: mockTicketId,
        tenantId: mockTenantId,
        status: TicketStatus.IN_PROGRESS,
        isWarningSent: false,
        ticketNumber: 'TCK-000010',
      });

      const result = await processor.process(mockJob);

      expect(mockPrisma.ticket.update).toHaveBeenCalledWith({
        where: { id: mockTicketId },
        data: { isWarningSent: true },
      });

      expect(mockPrisma.ticketAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'SLA_WARNING_TRIGGERED',
        }),
      });

      expect(result).toEqual(
        expect.objectContaining({
          processed: true,
          stage: 'WARNING',
        }),
      );
    });
  });
});
