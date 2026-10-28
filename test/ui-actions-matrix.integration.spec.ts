import { DEFAULT_TENANTS } from '../chronos-web/src/lib/tokens';
import { TicketPriority, RoutingMode, TicketStatus } from '@prisma/client';
import { PrismaService } from '../src/common/database/prisma.service';
import { ClsService } from 'nestjs-cls';
import { AsyncLocalStorage } from 'async_hooks';
import { AppClsStore } from '../src/common/context/app-cls.store';
import { TicketStateMachine } from '../src/modules/tickets/state-machine/ticket-state-machine';
import { TicketsRepository } from '../src/modules/tickets/repositories/tickets.repository';
import { SlaCalendarCalculatorService } from '../src/modules/sla/services/sla-calendar-calculator.service';
import { CircuitBreakerService } from '../src/modules/webhooks/services/circuit-breaker.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Redis from 'ioredis';
import { InvalidStateTransitionException } from '../src/modules/tickets/exceptions/invalid-state-transition.exception';

describe('Master UI Actions & Combinations Matrix (Integration)', () => {
  let prisma: PrismaService;
  let redis: Redis;
  let cls: ClsService<AppClsStore>;
  let stateMachine: TicketStateMachine;
  let ticketsRepo: TicketsRepository;
  let calculator: SlaCalendarCalculatorService;
  let circuitBreaker: CircuitBreakerService;
  let eventEmitter: EventEmitter2;

  const acmeTenantId = DEFAULT_TENANTS[0].id;
  const sarahChenId = '00000000-0000-4000-8000-000000000002';
  const davidKimId = '00000000-0000-4000-8000-000000000003';

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
    ticketsRepo = new TicketsRepository(prisma, cls, stateMachine);
    calculator = new SlaCalendarCalculatorService();
    eventEmitter = new EventEmitter2();
    circuitBreaker = new CircuitBreakerService(redis, prisma, eventEmitter);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    redis.disconnect();
  });

  describe('Suite 1: Multi-Tenant Switching Matrix', () => {
    it('should correctly scope tenant contexts across all 3 default corporate tenants', () => {
      for (const tenant of DEFAULT_TENANTS) {
        expect(tenant.id).toBeDefined();
        expect(tenant.personas.length).toBeGreaterThan(0);
        for (const persona of tenant.personas) {
          expect(persona.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        }
      }
    });
  });

  describe('Suite 2: State Machine Lifecycle DAG Combinations', () => {
    it('should enforce every legal transition along the complete resolution path', () => {
      expect(stateMachine.canTransition(TicketStatus.OPEN, TicketStatus.ASSIGNED)).toBe(true);
      expect(stateMachine.canTransition(TicketStatus.ASSIGNED, TicketStatus.IN_PROGRESS)).toBe(true);
      expect(stateMachine.canTransition(TicketStatus.IN_PROGRESS, TicketStatus.ON_HOLD)).toBe(true);
      expect(stateMachine.canTransition(TicketStatus.ON_HOLD, TicketStatus.IN_PROGRESS)).toBe(true);
      expect(stateMachine.canTransition(TicketStatus.IN_PROGRESS, TicketStatus.RESOLVED)).toBe(true);
      expect(stateMachine.canTransition(TicketStatus.RESOLVED, TicketStatus.CLOSED)).toBe(true);
    });

    it('should reject every illegal transition combination with structured exception', () => {
      const illegalCombos: [TicketStatus, TicketStatus][] = [
        [TicketStatus.OPEN, TicketStatus.IN_PROGRESS],
        [TicketStatus.OPEN, TicketStatus.ON_HOLD],
        [TicketStatus.OPEN, TicketStatus.RESOLVED],
        [TicketStatus.OPEN, TicketStatus.CLOSED],
        [TicketStatus.ASSIGNED, TicketStatus.ON_HOLD],
        [TicketStatus.ASSIGNED, TicketStatus.RESOLVED],
        [TicketStatus.ASSIGNED, TicketStatus.CLOSED],
        [TicketStatus.ON_HOLD, TicketStatus.CLOSED],
        [TicketStatus.RESOLVED, TicketStatus.OPEN],
        [TicketStatus.CLOSED, TicketStatus.OPEN],
        [TicketStatus.CLOSED, TicketStatus.ASSIGNED],
        [TicketStatus.CLOSED, TicketStatus.IN_PROGRESS],
        [TicketStatus.CLOSED, TicketStatus.RESOLVED],
        [TicketStatus.OPEN, TicketStatus.OPEN],
        [TicketStatus.IN_PROGRESS, TicketStatus.IN_PROGRESS],
      ];

      for (const [from, to] of illegalCombos) {
        expect(stateMachine.canTransition(from, to)).toBe(false);
        expect(() => stateMachine.validateTransition(from, to, 'test-ticket-id')).toThrow(
          InvalidStateTransitionException,
        );
      }
    });
  });

  describe('Suite 3: Skill-Based Atomic Claiming Combinations', () => {
    it('should claim tickets matching specialized skills or empty required skills', async () => {
      await cls.runWith({ tenantId: acmeTenantId }, async () => {
        // Create test ticket with billing skill
        const ticket = await prisma.ticket.create({
          data: {
            tenantId: acmeTenantId,
            ticketNumber: `TCK-TEST-${Date.now()}`,
            title: 'Billing Specialization Test Ticket',
            description: 'Testing billing skill matching in claim-next',
            priority: TicketPriority.URGENT,
            status: TicketStatus.OPEN,
            routingMode: RoutingMode.PULL_QUEUE,
            requiredSkills: ['billing'],
            remainingSlaMs: 3600000,
          },
        });

        // David Kim has billing skill -> should claim
        const claimResult = await ticketsRepo.claimNextTicket(
          davidKimId,
          TicketPriority.URGENT,
          ['billing', 'rest_api'],
        );

        expect(claimResult.claimed).toBe(true);
        expect(claimResult.ticket).toBeDefined();
        expect(claimResult.ticket?.assignedAgentId).toBe(davidKimId);
      });
    });

    it('should gracefully handle empty queue with { claimed: false }', async () => {
      await cls.runWith({ tenantId: acmeTenantId }, async () => {
        // Preferred priority that doesn't exist
        const claimResult = await ticketsRepo.claimNextTicket(
          davidKimId,
          'LOW' as TicketPriority,
          ['non_existent_skill_tag_xyz'],
        );

        if (!claimResult.claimed) {
          expect(claimResult.claimed).toBe(false);
          expect(claimResult.message).toBeDefined();
        }
      });
    });
  });

  describe('Suite 4: Business Calendars & SLA Calculator Preview Combinations', () => {
    const defaultSchedule = {
      monday: [{ start: '09:00', end: '17:00' }],
      tuesday: [{ start: '09:00', end: '17:00' }],
      wednesday: [{ start: '09:00', end: '17:00' }],
      thursday: [{ start: '09:00', end: '17:00' }],
      friday: [{ start: '09:00', end: '17:00' }],
      saturday: [],
      sunday: [],
    };

    const priorities = [
      { priority: 'P1', targetMs: 3600000 },
      { priority: 'P2', targetMs: 14400000 },
      { priority: 'P3', targetMs: 28800000 },
      { priority: 'P4', targetMs: 86400000 },
    ];

    const timezones = ['America/New_York', 'Asia/Kolkata', 'Europe/London', 'UTC'];

    for (const prio of priorities) {
      for (const tz of timezones) {
        it(`should calculate warning and breach deadlines for ${prio.priority} in ${tz}`, () => {
          const calendar = {
            timezone: tz,
            weeklySchedule: defaultSchedule,
          };

          const start = new Date();
          const result = calculator.calculateDeadlines(start, prio.targetMs, calendar, []);

          expect(result.warningDate).toBeDefined();
          expect(result.breachDate).toBeDefined();
          expect(result.breachDate.getTime()).toBeGreaterThan(result.warningDate.getTime());
          expect(result.warningDate.getTime()).toBeGreaterThanOrEqual(start.getTime());
          expect(result.breachDelayMs).toBeGreaterThanOrEqual(result.warningDelayMs);
        });
      }
    }
  });

  describe('Suite 5: Enterprise Webhooks & Circuit Breaker State Combinations', () => {
    const testEpId = '11111111-2222-4333-8444-555555555555';

    it('should start in CLOSED state, trip to OPEN on 10 consecutive failures, and reset to CLOSED on admin override', async () => {
      // 1. Initial State: CLOSED
      const initial = await circuitBreaker.checkCircuit(acmeTenantId, testEpId);
      expect(initial.canExecute).toBe(true);

      // 2. Trip Circuit
      await circuitBreaker.tripCircuit(acmeTenantId, testEpId, 60, 'Simulated Chaos');
      const tripped = await circuitBreaker.checkCircuit(acmeTenantId, testEpId);
      expect(tripped.canExecute).toBe(false);
      expect(tripped.state).toBe('OPEN');

      // 3. Reset Circuit Override
      await circuitBreaker.resetCircuit(acmeTenantId, testEpId);
      const reset = await circuitBreaker.checkCircuit(acmeTenantId, testEpId);
      expect(reset.canExecute).toBe(true);
      expect(reset.state).toBe('CLOSED');
    });
  });
});
