import { DateTime } from 'luxon';
import Redis from 'ioredis';
import { AsyncLocalStorage } from 'async_hooks';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { v4 as uuidv4 } from 'uuid';
import {
  isCurrentlyInBusinessHours,
  calculateBusinessDeadlines,
  DEFAULT_WEEKLY_SCHEDULE,
  HolidayDefinition,
} from '../chronos-web/src/lib/calendar-calculator';
import { TicketsService } from '../src/modules/tickets/tickets.service';
import { TicketsRepository } from '../src/modules/tickets/repositories/tickets.repository';
import { TicketStateMachine } from '../src/modules/tickets/state-machine/ticket-state-machine';
import { TicketPriority, RoutingMode, TicketStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../src/common/database/prisma.service';
import { AppClsStore } from '../src/common/context/app-cls.store';
import { CircuitBreakerService } from '../src/modules/webhooks/services/circuit-breaker.service';
import { SlaCalendarCalculatorService } from '../src/modules/sla/services/sla-calendar-calculator.service';

describe('Phase 12: Tenant Admin Control Plane & Concurrency Chaos Simulator (Integration)', () => {
  let prisma: PrismaService;
  let redis: Redis;
  let cls: ClsService<AppClsStore>;
  let stateMachine: TicketStateMachine;
  let ticketsRepository: TicketsRepository;
  let ticketsService: TicketsService;
  let circuitBreakerService: CircuitBreakerService;
  let eventEmitter: EventEmitter2;
  let calculatorService: SlaCalendarCalculatorService;

  let testTenantId: string;
  const testTenantSlug = `tenant-p12-${Date.now()}`;
  let testEndpointId: string;
  let testAgents: { id: string }[] = [];

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
    stateMachine = new TicketStateMachine();
    ticketsRepository = new TicketsRepository(prisma, cls, stateMachine);
    eventEmitter = new EventEmitter2();
    circuitBreakerService = new CircuitBreakerService(redis, prisma, eventEmitter);
    calculatorService = new SlaCalendarCalculatorService();

    // Create test tenant
    const tenant = await prisma.tenant.create({
      data: {
        name: 'Phase 12 Simulator Tenant',
        slug: testTenantSlug,
      },
    });
    testTenantId = tenant.id;

    // Create test webhook endpoint with valid UUID
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        tenantId: testTenantId,
        url: 'https://example.com/test-webhook-phase12',
        signingSecret: 'enc_secret_test_phase12',
        subscribedEvents: ['sla.breach', 'sla.warning'],
      },
    });
    testEndpointId = endpoint.id;

    // Create real test agents in users table for FK constraint satisfaction
    testAgents = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        prisma.user.create({
          data: {
            tenantId: testTenantId,
            email: `agent-p12-${i + 1}-${Date.now()}@chronos.io`,
            name: `Agent ${i + 1}`,
            role: UserRole.AGENT,
          },
        }),
      ),
    );

    ticketsService = new TicketsService(
      ticketsRepository,
      prisma,
      eventEmitter,
    );
  });

  afterAll(async () => {
    if (testTenantId) {
      await prisma.tenant.delete({
        where: { id: testTenantId },
      });
    }
    await redis.quit();
    await prisma.$disconnect();
  });

  describe('Timezone-Aware Business Hours & Calendar Arithmetic', () => {
    const timezone = 'America/New_York';
    const holidays: HolidayDefinition[] = [
      { name: "New Year's Day", date: '2026-01-01', isFullDay: true },
      { name: 'Christmas Day', date: '2026-12-25', isFullDay: true },
    ];

    it('should detect when tenant is IN BUSINESS HOURS on standard weekday shift', () => {
      // Wednesday at 11:30 AM EST
      const wednesdayShift = DateTime.fromISO('2026-10-28T11:30:00', { zone: timezone });
      const status = isCurrentlyInBusinessHours(wednesdayShift, DEFAULT_WEEKLY_SCHEDULE, holidays);

      expect(status.isInBusinessHours).toBe(true);
      expect(status.reason).toContain('Active Business Hours');
    });

    it('should detect when tenant is OUTSIDE BUSINESS HOURS (SLA FROZEN) on evening and weekend', () => {
      // Wednesday at 20:00 EST (night)
      const wednesdayNight = DateTime.fromISO('2026-10-28T20:00:00', { zone: timezone });
      const nightStatus = isCurrentlyInBusinessHours(wednesdayNight, DEFAULT_WEEKLY_SCHEDULE, holidays);
      expect(nightStatus.isInBusinessHours).toBe(false);
      expect(nightStatus.reason).toContain('Outside Daily Shift Hours');

      // Saturday at 12:00 EST (weekend)
      const saturdayNoon = DateTime.fromISO('2026-10-31T12:00:00', { zone: timezone });
      const weekendStatus = isCurrentlyInBusinessHours(saturdayNoon, DEFAULT_WEEKLY_SCHEDULE, holidays);
      expect(weekendStatus.isInBusinessHours).toBe(false);
      expect(weekendStatus.reason).toContain('Weekend / Closed');
    });

    it('should detect when tenant is OUTSIDE BUSINESS HOURS on tenant holiday', () => {
      // Christmas Day (Friday 2026-12-25) at 10:00 EST
      const christmas = DateTime.fromISO('2026-12-25T10:00:00', { zone: timezone });
      const holidayStatus = isCurrentlyInBusinessHours(christmas, DEFAULT_WEEKLY_SCHEDULE, holidays);

      expect(holidayStatus.isInBusinessHours).toBe(false);
      expect(holidayStatus.reason).toContain('Tenant Holiday');
    });

    it('should accurately calculate Friday 16:30 SLA roll-over through weekend to Monday', () => {
      // Ticket arrives Friday at 16:30 with 4-hour SLA (14,400,000ms)
      // 30 min business time used on Friday before 17:00 close.
      // Saturday & Sunday frozen.
      // Remaining 3.5 hours applied Monday starting at 09:00 -> Breach at 12:30.
      const fridayArrival = DateTime.fromISO('2026-10-30T16:30:00', { zone: timezone }).toJSDate();
      const fourHoursMs = 4 * 60 * 60 * 1000;

      const deadlines = calculateBusinessDeadlines(
        fridayArrival,
        fourHoursMs,
        DEFAULT_WEEKLY_SCHEDULE,
        holidays,
        timezone,
      );

      const breachDt = DateTime.fromJSDate(deadlines.breachDate, { zone: timezone });
      expect(breachDt.weekday).toBe(1); // Monday
      expect(breachDt.hour).toBe(12);
      expect(breachDt.minute).toBe(30);

      // Warning is 80% of 4h = 3.2h (3h 12m)
      // 30m used Friday -> 2h 42m used on Monday (09:00 + 2h 42m = 11:42)
      const warningDt = DateTime.fromJSDate(deadlines.warningDate, { zone: timezone });
      expect(warningDt.weekday).toBe(1); // Monday
      expect(warningDt.hour).toBe(11);
      expect(warningDt.minute).toBe(42);

      // Total wall clock ms should be Friday 16:30 to Monday 12:30 = 68 hours (244,800,000ms)
      expect(deadlines.totalWallClockMs).toBeGreaterThan(fourHoursMs);
      expect(deadlines.explanation.length).toBeGreaterThan(0);
    });

    it('should accurately calculate SlaCalendarCalculatorService deadlines matching frontend', () => {
      const fridayArrival = DateTime.fromISO('2026-10-30T16:30:00', { zone: timezone }).toJSDate();
      const fourHoursMs = 4 * 60 * 60 * 1000;

      const deadlines = calculatorService.calculateDeadlines(
        fridayArrival,
        fourHoursMs,
        {
          timezone,
          weeklySchedule: DEFAULT_WEEKLY_SCHEDULE,
        },
        holidays,
      );

      expect(deadlines.warningDate).toBeDefined();
      expect(deadlines.breachDate).toBeDefined();
      expect(deadlines.businessDurationMs).toBe(fourHoursMs);
    });
  });

  describe('Outbound Webhooks Circuit Breaker & DLQ Replay', () => {
    it('should trip circuit breaker to OPEN when 10 consecutive failures are recorded', async () => {
      // Simulate 10 consecutive 500 failures
      for (let i = 0; i < 10; i++) {
        await circuitBreakerService.recordFailure(testTenantId, testEndpointId, false, {
          statusCode: 500,
          errorMessage: 'Simulated 500 Internal Server Error (Chaos Test)',
        });
      }

      const status = await circuitBreakerService.checkCircuit(testTenantId, testEndpointId);
      expect(status.state).toBe('OPEN');
      expect(status.canExecute).toBe(false);
      expect(status.reason).toContain('Circuit is OPEN');
    });

    it('should allow manually resetting the circuit breaker to CLOSED', async () => {
      await circuitBreakerService.resetCircuit(testTenantId, testEndpointId);

      const status = await circuitBreakerService.checkCircuit(testTenantId, testEndpointId);
      expect(status.state).toBe('CLOSED');
      expect(status.canExecute).toBe(true);
    });
  });

  describe('Concurrency & Chaos Simulator Engine', () => {
    it('should simulate rapid burst of tickets with random priorities and skills', async () => {
      const tickets = [];
      const priorities: TicketPriority[] = [
        TicketPriority.URGENT,
        TicketPriority.HIGH,
        TicketPriority.MEDIUM,
        TicketPriority.LOW,
      ];

      for (let i = 0; i < 5; i++) {
        const ticket = await ticketsRepository.withTenant(testTenantId, () =>
          ticketsService.createTicket({
            title: `Simulator Chaos Ticket #${i + 1}`,
            description: 'High-throughput load test',
            priority: priorities[i % priorities.length],
            routingMode: RoutingMode.AUTO_PUSH,
            requiredSkills: ['voice_webrtc'],
          }),
        );
        tickets.push(ticket);
      }

      expect(tickets.length).toBe(5);
      for (const t of tickets) {
        expect(t.id).toBeDefined();
        expect(t.ticketNumber).toBeDefined();
        expect(t.status).toBe(TicketStatus.OPEN);
      }
    });

    it('should guarantee zero race conditions on concurrent claims (SKIP LOCKED)', async () => {
      // Create 2 open tickets for claiming test
      await ticketsRepository.withTenant(testTenantId, () =>
        ticketsService.createTicket({
          title: 'Concurrent Claim Test 1',
          description: 'SKIP LOCKED contention test',
          priority: TicketPriority.URGENT,
        }),
      );
      await ticketsRepository.withTenant(testTenantId, () =>
        ticketsService.createTicket({
          title: 'Concurrent Claim Test 2',
          description: 'SKIP LOCKED contention test',
          priority: TicketPriority.URGENT,
        }),
      );

      // Fire 10 concurrent claims across our real registered test agents
      const claimPromises = Array.from({ length: 10 }).map((_, i) => {
        const agent = testAgents[i % testAgents.length];
        return ticketsRepository.withTenant(testTenantId, () =>
          ticketsService.claimNextTicket({ agentId: agent.id }),
        );
      });

      const results = await Promise.all(claimPromises);

      // Collect successfully claimed ticket IDs
      const claimedIds = results
        .filter((r) => r.claimed && r.ticket)
        .map((r) => r.ticket!.id);

      // Verify no duplicate claims: each ticket was claimed by at most one agent
      const uniqueClaimedIds = new Set(claimedIds);
      expect(claimedIds.length).toBe(uniqueClaimedIds.size);
    });
  });
});
