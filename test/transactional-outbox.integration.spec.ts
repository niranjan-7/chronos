import { Queue } from 'bullmq';
import { AsyncLocalStorage } from 'async_hooks';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { OutboxStatus, TicketPriority, TicketStatus } from '@prisma/client';
import { PrismaService } from '../src/common/database/prisma.service';
import { AppClsStore } from '../src/common/context/app-cls.store';
import { SlaQueueService } from '../src/modules/sla/services/sla-queue.service';
import { SlaPolicyService } from '../src/modules/sla/services/sla-policy.service';
import { SlaCalendarCalculatorService } from '../src/modules/sla/services/sla-calendar-calculator.service';
import { TenantCalendarService } from '../src/modules/tenants/services/tenant-calendar.service';
import { TicketsRepository } from '../src/modules/tickets/repositories/tickets.repository';
import { TicketsService } from '../src/modules/tickets/tickets.service';
import { TicketStateMachine } from '../src/modules/tickets/state-machine/ticket-state-machine';
import { OutboxRelayService } from '../src/modules/outbox/services/outbox-relay.service';
import {
  SLA_MONITOR_QUEUE,
  getSlaBreachJobId,
  getSlaWarningJobId,
} from '../src/modules/sla/constants/sla.constants';
import { SlaJobPayload } from '../src/modules/sla/interfaces/sla-job-payload.interface';

describe('Phase 6: Transactional Outbox Pattern Integration (Zero-Loss Event Publishing)', () => {
  let prisma: PrismaService;
  let cls: ClsService<AppClsStore>;
  let queue: Queue<SlaJobPayload>;
  let eventEmitter: EventEmitter2;
  let slaPolicyService: SlaPolicyService;
  let calendarCalculator: SlaCalendarCalculatorService;
  let tenantCalendarService: TenantCalendarService;
  let ticketsService: TicketsService;
  let outboxRelayService: OutboxRelayService;

  let testTenantId: string;
  const testTenantSlug = `outbox-integ-${Date.now()}`;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();

    const als = new AsyncLocalStorage();
    cls = new ClsService<AppClsStore>(als);

    queue = new Queue<SlaJobPayload>(SLA_MONITOR_QUEUE, {
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || 'redis_secret',
      },
    });

    slaPolicyService = new SlaPolicyService(prisma);
    calendarCalculator = new SlaCalendarCalculatorService();
    tenantCalendarService = new TenantCalendarService(prisma);
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

    // 1. Provision test tenant
    const tenant = await prisma.tenant.create({
      data: {
        name: 'Outbox Integration Tenant',
        slug: testTenantSlug,
      },
    });
    testTenantId = tenant.id;

    // 2. Setup policies & calendar
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

  it('guarantees atomic dual-write: writes Ticket, AuditLog, and OutboxEvent in one transaction', async () => {
    // 1. Create a ticket via HTTP service
    const ticket = await cls.runWith(
      { tenantId: testTenantId, isSystemOperation: false },
      () =>
        ticketsService.createTicket({
          title: 'Transactional Outbox Zero Loss Test',
          description: 'Testing atomic Postgres outbox commit',
          priority: TicketPriority.URGENT, // P1: 60m SLA
        }),
    );

    expect(ticket.id).toBeDefined();

    // 2. Verify OutboxEvent exists in PostgreSQL for this ticket
    const outboxEvents = await prisma.outboxEvent.findMany({
      where: {
        tenantId: testTenantId,
        aggregateId: ticket.id,
        eventType: 'ticket.created',
      },
    });

    expect(outboxEvents.length).toBe(1);
    const event = outboxEvents[0]!;
    expect(event.aggregateType).toBe('TICKET');
    expect(event.aggregateId).toBe(ticket.id);

    // Wait briefly for pg_notify listener & relay to execute
    await new Promise((r) => setTimeout(r, 200));

    // 3. Verify OutboxRelay picked up event and marked it PUBLISHED
    const updatedEvent = await prisma.outboxEvent.findUnique({
      where: { id: event.id },
    });
    expect(updatedEvent!.status).toBe(OutboxStatus.PUBLISHED);
    expect(updatedEvent!.processedAt).toBeDefined();

    // 4. Verify BullMQ delayed jobs exist in Redis with deterministic IDs
    const warnJobId = getSlaWarningJobId(testTenantId, ticket.id);
    const breachJobId = getSlaBreachJobId(testTenantId, ticket.id);

    const warnJob = await queue.getJob(warnJobId);
    const breachJob = await queue.getJob(breachJobId);

    expect(warnJob).toBeDefined();
    expect(breachJob).toBeDefined();

    // 5. Verify Ticket resolutionDueAt was populated by relay
    const updatedTicket = await prisma.ticket.findUnique({
      where: { id: ticket.id },
    });
    expect(updatedTicket!.resolutionDueAt).toBeDefined();
    expect(Number(updatedTicket!.remainingSlaMs)).toBeGreaterThan(0);
  });

  it('enforces idempotency: duplicate relay sweeps never create duplicate BullMQ jobs', async () => {
    const ticket = await cls.runWith(
      { tenantId: testTenantId, isSystemOperation: false },
      () =>
        ticketsService.createTicket({
          title: 'Idempotency Verification Ticket',
          description: 'Ensuring zero duplicate SLA timers',
          priority: TicketPriority.HIGH,
        }),
    );

    // Wait for relay
    await new Promise((r) => setTimeout(r, 200));

    const warnJobId = getSlaWarningJobId(testTenantId, ticket.id);
    const breachJobId = getSlaBreachJobId(testTenantId, ticket.id);

    const warnJobFirst = await queue.getJob(warnJobId);
    const breachJobFirst = await queue.getJob(breachJobId);
    expect(warnJobFirst).toBeDefined();
    expect(breachJobFirst).toBeDefined();

    // Force a secondary relay sweep
    await outboxRelayService.processPendingEvents();

    // Verify still exactly one job with that deterministic ID
    const warnJobSecond = await queue.getJob(warnJobId);
    const breachJobSecond = await queue.getJob(breachJobId);
    expect(warnJobSecond!.id).toBe(warnJobFirst!.id);
    expect(breachJobSecond!.id).toBe(breachJobFirst!.id);
  });

  it('relays state machine transitions: freezes SLA on ON_HOLD and resumes on IN_PROGRESS', async () => {
    // 1. Create ticket
    const ticket = await cls.runWith(
      { tenantId: testTenantId, isSystemOperation: false },
      () =>
        ticketsService.createTicket({
          title: 'State Transition Outbox Test',
          description: 'Testing hold and resume via outbox',
          priority: TicketPriority.HIGH,
        }),
    );

    await new Promise((r) => setTimeout(r, 200));

    const warnJobId = getSlaWarningJobId(testTenantId, ticket.id);
    const breachJobId = getSlaBreachJobId(testTenantId, ticket.id);

    expect(await queue.getJob(warnJobId)).toBeDefined();
    expect(await queue.getJob(breachJobId)).toBeDefined();

    // 2. Transition OPEN -> ASSIGNED -> IN_PROGRESS -> ON_HOLD
    await cls.runWith({ tenantId: testTenantId, isSystemOperation: false }, async () => {
      await ticketsService.transitionTicket(ticket.id, {
        status: TicketStatus.ASSIGNED,
        reason: 'Assigned',
      });
      await ticketsService.transitionTicket(ticket.id, {
        status: TicketStatus.IN_PROGRESS,
        reason: 'Investigating',
      });
      await ticketsService.transitionTicket(ticket.id, {
        status: TicketStatus.ON_HOLD,
        reason: 'Waiting for vendor',
      });
    });

    // Wait for pg_notify & relay processing
    await new Promise((r) => setTimeout(r, 200));

    // Verify BullMQ jobs cancelled on HOLD
    expect(await queue.getJob(warnJobId)).toBeFalsy();
    expect(await queue.getJob(breachJobId)).toBeFalsy();

    // Verify ticket has slaPausedAt
    const onHoldTicket = await prisma.ticket.findUnique({
      where: { id: ticket.id },
    });
    expect(onHoldTicket!.slaPausedAt).toBeDefined();

    // 3. Resume ON_HOLD -> IN_PROGRESS
    await cls.runWith({ tenantId: testTenantId, isSystemOperation: false }, async () => {
      await ticketsService.transitionTicket(ticket.id, {
        status: TicketStatus.IN_PROGRESS,
        reason: 'Vendor answered',
      });
    });

    await new Promise((r) => setTimeout(r, 200));

    // Verify fresh BullMQ breach job re-enqueued
    const resumedBreachJob = await queue.getJob(breachJobId);
    expect(resumedBreachJob).toBeDefined();

    // 4. Resolve ticket
    await cls.runWith({ tenantId: testTenantId, isSystemOperation: false }, async () => {
      await ticketsService.transitionTicket(ticket.id, {
        status: TicketStatus.RESOLVED,
        reason: 'Fixed',
      });
    });

    await new Promise((r) => setTimeout(r, 200));

    // Verify jobs cleaned up
    expect(await queue.getJob(warnJobId)).toBeFalsy();
    expect(await queue.getJob(breachJobId)).toBeFalsy();
  });
});
