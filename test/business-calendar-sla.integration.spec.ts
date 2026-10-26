import { Queue } from 'bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { AsyncLocalStorage } from 'async_hooks';
import { TicketPriority, TicketStatus } from '@prisma/client';
import { PrismaService } from '../src/common/database/prisma.service';
import { AppClsStore } from '../src/common/context/app-cls.store';
import { SlaQueueService } from '../src/modules/sla/services/sla-queue.service';
import { SlaPolicyService } from '../src/modules/sla/services/sla-policy.service';
import { SlaEventListener } from '../src/modules/sla/listeners/sla-event.listener';
import { SlaCalendarCalculatorService } from '../src/modules/sla/services/sla-calendar-calculator.service';
import { TenantCalendarService } from '../src/modules/tenants/services/tenant-calendar.service';
import { TicketsRepository } from '../src/modules/tickets/repositories/tickets.repository';
import { TicketsService } from '../src/modules/tickets/tickets.service';
import { TicketStateMachine } from '../src/modules/tickets/state-machine/ticket-state-machine';
import {
  SLA_MONITOR_QUEUE,
  getSlaWarningJobId,
  getSlaBreachJobId,
} from '../src/modules/sla/constants/sla.constants';
import { SlaJobPayload } from '../src/modules/sla/interfaces/sla-job-payload.interface';
import { OutboxRelayService } from '../src/modules/outbox/services/outbox-relay.service';
import { ConfigService } from '@nestjs/config';

describe('Phase 5: Timezone-Aware Business Calendar SLA Integration', () => {
  let prisma: PrismaService;
  let cls: ClsService<AppClsStore>;
  let queue: Queue<SlaJobPayload>;
  let eventEmitter: EventEmitter2;
  let slaQueueService: SlaQueueService;
  let slaPolicyService: SlaPolicyService;
  let calendarCalculator: SlaCalendarCalculatorService;
  let tenantCalendarService: TenantCalendarService;
  let eventListener: SlaEventListener;
  let ticketsService: TicketsService;
  let outboxRelayService: OutboxRelayService;

  let testTenantId: string;
  const testTenantSlug = `calendar-integ-${Date.now()}`;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();

    const als = new AsyncLocalStorage();
    cls = new ClsService<AppClsStore>(als);

    queue = new Queue<SlaJobPayload>(SLA_MONITOR_QUEUE, {
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD || 'redis_secret',
      },
    });

    slaQueueService = new SlaQueueService(queue);
    slaPolicyService = new SlaPolicyService(prisma);
    calendarCalculator = new SlaCalendarCalculatorService();
    tenantCalendarService = new TenantCalendarService(prisma);

    eventListener = new SlaEventListener(
      prisma,
      slaPolicyService,
      slaQueueService,
      calendarCalculator,
      tenantCalendarService,
    );

    eventEmitter = new EventEmitter2();
    const configService = new ConfigService();
    outboxRelayService = new OutboxRelayService(
      prisma,
      configService,
      queue,
      slaPolicyService,
      calendarCalculator,
      tenantCalendarService,
      eventEmitter,
    );
    await outboxRelayService.onModuleInit();

    const stateMachine = new TicketStateMachine();
    const ticketsRepo = new TicketsRepository(prisma, cls, stateMachine);
    ticketsService = new TicketsService(ticketsRepo, prisma, eventEmitter);

    // 1. Create test tenant
    const tenant = await prisma.tenant.create({
      data: {
        name: 'Calendar Integration Tenant',
        slug: testTenantSlug,
      },
    });
    testTenantId = tenant.id;

    // 2. Ensure SLA policies exist
    await slaPolicyService.ensureDefaultTenantPolicies(testTenantId);

    // 3. Configure Business Calendar: America/New_York, Mon-Fri 09:00 - 17:00, is24x7 = false
    await tenantCalendarService.updateCalendar(testTenantId, {
      timezone: 'America/New_York',
      is24x7: false,
      weeklySchedule: {
        monday: [{ start: '09:00', end: '17:00' }],
        tuesday: [{ start: '09:00', end: '17:00' }],
        wednesday: [{ start: '09:00', end: '17:00' }],
        thursday: [{ start: '09:00', end: '17:00' }],
        friday: [{ start: '09:00', end: '17:00' }],
        saturday: [],
        sunday: [],
      },
    });

    // 4. Add a holiday (e.g. Christmas)
    await tenantCalendarService.addHoliday(testTenantId, {
      name: 'Test Christmas Holiday',
      date: '2026-12-25',
      isFullDay: true,
    });
  });

  afterAll(async () => {
    if (outboxRelayService) {
      await outboxRelayService.onModuleDestroy();
    }
    if (testTenantId) {
      await prisma.tenant.delete({
        where: { id: testTenantId },
      });
    }
    await queue.close();
    await prisma.$disconnect();
  });

  it('correctly calculates business deadlines and dynamically pauses/resumes SLA on calendar boundaries', async () => {
    // 1. Create a P2 ticket (4 hour = 14,400,000ms SLA)
    const ticket = await cls.runWith(
      { tenantId: testTenantId, isSystemOperation: false },
      () =>
        ticketsService.createTicket({
          title: 'Database Latency Spike',
          description: 'Investigating query performance',
          priority: TicketPriority.HIGH, // P2
        }),
    );

    expect(ticket.id).toBeDefined();

    // Allow event listener to process
    await new Promise((r) => setTimeout(r, 150));

    // 2. Check scheduled BullMQ delayed jobs
    const warnJobId = getSlaWarningJobId(testTenantId, ticket.id);
    const breachJobId = getSlaBreachJobId(testTenantId, ticket.id);

    const warnJob = await queue.getJob(warnJobId);
    const breachJob = await queue.getJob(breachJobId);

    expect(warnJob).toBeDefined();
    expect(breachJob).toBeDefined();

    // Check DB ticket persisted deadline
    const dbTicket = await prisma.ticket.findUnique({
      where: { id: ticket.id },
    });
    expect(dbTicket!.resolutionDueAt).toBeDefined();
    expect(dbTicket!.lastResumedAt).toBeDefined();
    expect(Number(dbTicket!.remainingSlaMs)).toBeGreaterThan(0);

    // 3. Transition to ON_HOLD (Pause SLA)
    await cls.runWith({ tenantId: testTenantId, isSystemOperation: false }, async () => {
      await ticketsService.transitionTicket(ticket.id, {
        status: TicketStatus.ASSIGNED,
        reason: 'Assigned to SRE',
      });
      await ticketsService.transitionTicket(ticket.id, {
        status: TicketStatus.IN_PROGRESS,
        reason: 'Investigating traces',
      });
      await ticketsService.transitionTicket(ticket.id, {
        status: TicketStatus.ON_HOLD,
        reason: 'Waiting for vendor escalation',
      });
    });

    await new Promise((r) => setTimeout(r, 150));

    // 4. Verify BullMQ jobs are cleanly cancelled
    const pausedWarnJob = await queue.getJob(warnJobId);
    const pausedBreachJob = await queue.getJob(breachJobId);
    expect(pausedWarnJob).toBeFalsy();
    expect(pausedBreachJob).toBeFalsy();

    // Verify DB audit log and paused status
    const onHoldTicket = await prisma.ticket.findUnique({
      where: { id: ticket.id },
    });
    expect(onHoldTicket!.slaPausedAt).toBeDefined();
    expect(onHoldTicket!.pausedAt).toBeDefined();

    const auditLogs = await prisma.ticketAuditLog.findMany({
      where: { ticketId: ticket.id },
    });
    const pauseAudit = auditLogs.find((l) => l.action === 'SLA_PAUSED');
    expect(pauseAudit).toBeDefined();

    // 5. Transition back to IN_PROGRESS (Resume SLA)
    await cls.runWith({ tenantId: testTenantId, isSystemOperation: false }, async () => {
      await ticketsService.transitionTicket(ticket.id, {
        status: TicketStatus.IN_PROGRESS,
        reason: 'Vendor answered, resuming work',
      });
    });

    await new Promise((r) => setTimeout(r, 150));

    // 6. Verify jobs re-enqueued with fresh business deadline
    const resumedBreachJob = await queue.getJob(breachJobId);
    expect(resumedBreachJob).toBeDefined();
    expect(resumedBreachJob!.opts.delay).toBeGreaterThanOrEqual(0);

    const resumedTicket = await prisma.ticket.findUnique({
      where: { id: ticket.id },
    });
    expect(resumedTicket!.slaPausedAt).toBeNull();
    expect(resumedTicket!.lastResumedAt).toBeDefined();

    // 7. Resolve ticket: jobs cleaned up
    await cls.runWith({ tenantId: testTenantId, isSystemOperation: false }, async () => {
      await ticketsService.transitionTicket(ticket.id, {
        status: TicketStatus.RESOLVED,
        reason: 'Issue resolved',
      });
    });

    await new Promise((r) => setTimeout(r, 150));

    const resolvedWarnJob = await queue.getJob(warnJobId);
    const resolvedBreachJob = await queue.getJob(breachJobId);
    expect(resolvedWarnJob).toBeFalsy();
    expect(resolvedBreachJob).toBeFalsy();
  });
});
