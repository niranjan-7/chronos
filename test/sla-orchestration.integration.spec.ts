import { Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { AsyncLocalStorage } from 'async_hooks';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TicketPriority, TicketStatus } from '@prisma/client';
import { PrismaService } from '../src/common/database/prisma.service';
import { AppClsStore } from '../src/common/context/app-cls.store';
import { SlaQueueService } from '../src/modules/sla/services/sla-queue.service';
import { SlaPolicyService } from '../src/modules/sla/services/sla-policy.service';
import { SlaCalendarCalculatorService } from '../src/modules/sla/services/sla-calendar-calculator.service';
import { TenantCalendarService } from '../src/modules/tenants/services/tenant-calendar.service';
import { SlaEventListener } from '../src/modules/sla/listeners/sla-event.listener';
import { TicketsRepository } from '../src/modules/tickets/repositories/tickets.repository';
import { TicketsService } from '../src/modules/tickets/tickets.service';
import { TicketStateMachine } from '../src/modules/tickets/state-machine/ticket-state-machine';
import {
  SLA_MONITOR_QUEUE,
  getSlaBreachJobId,
  getSlaWarningJobId,
} from '../src/modules/sla/constants/sla.constants';
import { SlaJobPayload } from '../src/modules/sla/interfaces/sla-job-payload.interface';
import { OutboxRelayService } from '../src/modules/outbox/services/outbox-relay.service';
import { ConfigService } from '@nestjs/config';

describe('SLA Orchestration Engine Integration (Redis BullMQ + PostgreSQL)', () => {
  let prisma: PrismaService;
  let cls: ClsService<AppClsStore>;
  let queue: Queue<SlaJobPayload>;
  let slaQueueService: SlaQueueService;
  let slaPolicyService: SlaPolicyService;
  let eventListener: SlaEventListener;
  let eventEmitter: EventEmitter2;
  let ticketsService: TicketsService;
  let outboxRelayService: OutboxRelayService;

  let testTenantId: string;
  const testTenantSlug = `sla-integration-${Date.now()}`;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();

    const als = new AsyncLocalStorage();
    cls = new ClsService<AppClsStore>(als);

    // BullMQ Queue connected to real local Redis
    queue = new Queue<SlaJobPayload>(SLA_MONITOR_QUEUE, {
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || 'redis_secret',
      },
    });

    slaQueueService = new SlaQueueService(queue);
    slaPolicyService = new SlaPolicyService(prisma);
    const calendarCalculator = new SlaCalendarCalculatorService();
    const tenantCalendarService = new TenantCalendarService(prisma);
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

    // Provision test tenant with default P1-P4 SLA policies
    const tenant = await prisma.tenant.create({
      data: {
        name: 'SLA Integration Tenant',
        slug: testTenantSlug,
      },
    });
    testTenantId = tenant.id;

    await slaPolicyService.ensureDefaultTenantPolicies(testTenantId);
    await tenantCalendarService.updateCalendar(testTenantId, { is24x7: true });
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

  it('orchestrates ticket creation -> BullMQ delayed scheduling -> Pause on HOLD -> Resume -> Clear on RESOLVED', async () => {
    // 1. Create P1 Ticket (15m response / 60m resolution)
    const ticket = await cls.runWith(
      { tenantId: testTenantId, isSystemOperation: false },
      () =>
        ticketsService.createTicket({
          title: 'P1 Production Outage',
          description: 'Payment gateway down',
          priority: TicketPriority.URGENT,
        }),
    );

    expect(ticket.id).toBeDefined();

    // Small delay to allow event loop tick for eventEmitter
    await new Promise((r) => setTimeout(r, 100));

    // 2. Verify BullMQ delayed jobs exist in Redis with deterministic IDs
    const warnJobId = getSlaWarningJobId(testTenantId, ticket.id);
    const breachJobId = getSlaBreachJobId(testTenantId, ticket.id);

    const warnJob = await queue.getJob(warnJobId);
    const breachJob = await queue.getJob(breachJobId);

    expect(warnJob).toBeDefined();
    expect(breachJob).toBeDefined();

    // P1 resolution is 60m = 3,600,000ms.
    // Warning is at 80% = 2,880,000ms.
    expect(warnJob!.opts.delay).toBeGreaterThanOrEqual(2870000);
    expect(warnJob!.opts.delay).toBeLessThanOrEqual(2880000);
    expect(breachJob!.opts.delay).toBeGreaterThanOrEqual(3590000);
    expect(breachJob!.opts.delay).toBeLessThanOrEqual(3600000);

    // 3. Verify ticket DB row was updated with resolution deadline
    const updatedDbTicket = await prisma.ticket.findUnique({
      where: { id: ticket.id },
    });
    expect(updatedDbTicket!.resolutionDueAt).toBeDefined();
    expect(updatedDbTicket!.remainingSlaMs).toBeDefined();

    // 4. Transition ticket: OPEN -> ASSIGNED -> IN_PROGRESS -> ON_HOLD (Pause SLA)
    await cls.runWith({ tenantId: testTenantId, isSystemOperation: false }, async () => {
      await ticketsService.transitionTicket(ticket.id, {
        status: TicketStatus.ASSIGNED,
        reason: 'Assigned to incident commander',
      });
      await ticketsService.transitionTicket(ticket.id, {
        status: TicketStatus.IN_PROGRESS,
        reason: 'Investigating payment gateway',
      });
      await ticketsService.transitionTicket(ticket.id, {
        status: TicketStatus.ON_HOLD,
        reason: 'Waiting on third-party provider response',
      });
    });

    await new Promise((r) => setTimeout(r, 100));

    // 5. Verify BullMQ jobs were removed from Redis during ON_HOLD
    const pausedWarnJob = await queue.getJob(warnJobId);
    const pausedBreachJob = await queue.getJob(breachJobId);
    expect(pausedWarnJob).toBeFalsy();
    expect(pausedBreachJob).toBeFalsy();

    // Verify pausedAt & remainingSlaMs persisted
    const onHoldTicket = await prisma.ticket.findUnique({
      where: { id: ticket.id },
    });
    expect(onHoldTicket!.pausedAt).toBeDefined();
    expect(Number(onHoldTicket!.remainingSlaMs)).toBeGreaterThan(0);

    // 6. Resume ticket: ON_HOLD -> IN_PROGRESS
    await cls.runWith({ tenantId: testTenantId, isSystemOperation: false }, async () => {
      await ticketsService.transitionTicket(ticket.id, {
        status: TicketStatus.IN_PROGRESS,
        reason: 'Provider responded, resumed investigation',
      });
    });

    await new Promise((r) => setTimeout(r, 100));

    // 7. Verify BullMQ jobs re-enqueued in Redis with the remaining duration!
    const resumedBreachJob = await queue.getJob(breachJobId);
    expect(resumedBreachJob).toBeDefined();
    expect(resumedBreachJob!.opts.delay).toBeGreaterThanOrEqual(Number(onHoldTicket!.remainingSlaMs) - 1000);
    expect(resumedBreachJob!.opts.delay).toBeLessThanOrEqual(Number(onHoldTicket!.remainingSlaMs));

    // 8. Resolve ticket: IN_PROGRESS -> RESOLVED
    await cls.runWith({ tenantId: testTenantId, isSystemOperation: false }, async () => {
      await ticketsService.transitionTicket(ticket.id, {
        status: TicketStatus.RESOLVED,
        reason: 'Root cause fixed',
      });
    });

    await new Promise((r) => setTimeout(r, 100));

    // 9. Verify BullMQ jobs cleaned up on RESOLVED
    const resolvedWarnJob = await queue.getJob(warnJobId);
    const resolvedBreachJob = await queue.getJob(breachJobId);
    expect(resolvedWarnJob).toBeFalsy();
    expect(resolvedBreachJob).toBeFalsy();
  });
});
