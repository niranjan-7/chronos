import Redis from 'ioredis';
import { AsyncLocalStorage } from 'async_hooks';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AgentStatus, RoutingMode, TicketPriority, TicketStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../src/common/database/prisma.service';
import { AppClsStore } from '../src/common/context/app-cls.store';
import { TicketStateMachine } from '../src/modules/tickets/state-machine/ticket-state-machine';
import { TicketsRepository } from '../src/modules/tickets/repositories/tickets.repository';
import { TicketsService } from '../src/modules/tickets/tickets.service';
import { RoutingRedisService } from '../src/modules/routing/services/routing-redis.service';
import { RoutingService } from '../src/modules/routing/routing.service';
import { RoutingEventListener } from '../src/modules/routing/listeners/routing-event.listener';
import {
  AGENT_CAPACITY_FREED_EVENT,
  TICKET_CREATED_EVENT,
} from '../src/common/events/domain-event.constants';

describe('Phase 7: High-Throughput Skill-Based & Capacity-Aware Auto-Routing Integration', () => {
  let prisma: PrismaService;
  let redis: Redis;
  let cls: ClsService<AppClsStore>;
  let ticketsRepo: TicketsRepository;
  let ticketsService: TicketsService;
  let routingRedisService: RoutingRedisService;
  let routingService: RoutingService;
  let routingListener: RoutingEventListener;
  let eventEmitter: EventEmitter2;

  let testTenantId: string;
  let agentAId: string;
  let agentBId: string;
  const testTenantSlug = `routing-integ-${Date.now()}`;

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

    const stateMachine = new TicketStateMachine();
    ticketsRepo = new TicketsRepository(prisma, cls, stateMachine);
    eventEmitter = new EventEmitter2();
    ticketsService = new TicketsService(ticketsRepo, prisma, eventEmitter);

    routingRedisService = new RoutingRedisService(redis);
    routingService = new RoutingService(prisma, ticketsRepo, cls, routingRedisService);
    routingListener = new RoutingEventListener(routingService, prisma);

    // Wire event listeners
    eventEmitter.on(TICKET_CREATED_EVENT, (event) => routingListener.handleTicketCreated(event));
    eventEmitter.on(AGENT_CAPACITY_FREED_EVENT, (event) =>
      routingListener.handleAgentCapacityFreed(event),
    );

    // 1. Create test tenant
    const tenant = await prisma.tenant.create({
      data: {
        name: 'Skill Routing Integration Tenant',
        slug: testTenantSlug,
      },
    });
    testTenantId = tenant.id;

    // 2. Create Agent A (Proficiency 5, Max Capacity 2)
    const agentA = await prisma.user.create({
      data: {
        tenantId: testTenantId,
        email: `agent-a-${Date.now()}@chronos.io`,
        name: 'Agent Alpha (Senior Billing Specialist)',
        role: UserRole.AGENT,
        status: AgentStatus.ONLINE,
        maxConcurrentTickets: 2,
      },
    });
    agentAId = agentA.id;

    // 3. Create Agent B (Proficiency 4, Max Capacity 2)
    const agentB = await prisma.user.create({
      data: {
        tenantId: testTenantId,
        email: `agent-b-${Date.now()}@chronos.io`,
        name: 'Agent Beta (Billing Specialist)',
        role: UserRole.AGENT,
        status: AgentStatus.ONLINE,
        maxConcurrentTickets: 2,
      },
    });
    agentBId = agentB.id;

    // 4. Register skills and initialize Redis structures
    await routingService.registerAgentSkills(
      testTenantId,
      agentAId,
      [{ skill: 'billing', proficiency: 5 }],
      2,
    );
    await routingService.registerAgentSkills(
      testTenantId,
      agentBId,
      [{ skill: 'billing', proficiency: 4 }],
      2,
    );
  });

  afterAll(async () => {
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
    await redis.quit();
    await prisma.$disconnect();
  });

  it('1. verifies initial Redis composite scores based on proficiency and capacity', async () => {
    // Formula: (proficiency * 100) + ((max_capacity - load) / max_capacity) * 50
    // Agent A: (5 * 100) + ((2 - 0) / 2) * 50 = 550
    // Agent B: (4 * 100) + ((2 - 0) / 2) * 50 = 450
    const scoreA = await routingRedisService.getAgentSkillScore(testTenantId, 'billing', agentAId);
    const scoreB = await routingRedisService.getAgentSkillScore(testTenantId, 'billing', agentBId);

    expect(scoreA).toBe(550);
    expect(scoreB).toBe(450);

    const loadA = await routingRedisService.getAgentActiveLoad(testTenantId, agentAId);
    const loadB = await routingRedisService.getAgentActiveLoad(testTenantId, agentBId);

    expect(loadA).toBe(0);
    expect(loadB).toBe(0);
  });

  it('2. prioritizes highest score agent and updates live composite scores linearly', async () => {
    // Create Ticket 1
    const t1 = await cls.runWith({ tenantId: testTenantId, isSystemOperation: false }, () =>
      ticketsService.createTicket({
        title: 'Billing Issue 1',
        description: 'Double charge query',
        priority: TicketPriority.HIGH,
        requiredSkills: ['billing'],
      }),
    );

    // Auto-route Ticket 1
    const route1 = await routingService.autoRouteTicket(testTenantId, t1.id, ['billing']);
    expect(route1.routed).toBe(true);
    expect(route1.agentId).toBe(agentAId); // Agent A picked (score 550 vs 450)

    // After 1 ticket, Agent A active load is 1
    // New score for Agent A: 500 + ((2 - 1) / 2) * 50 = 525
    const scoreAAfter1 = await routingRedisService.getAgentSkillScore(
      testTenantId,
      'billing',
      agentAId,
    );
    expect(scoreAAfter1).toBe(525);

    // Create Ticket 2
    const t2 = await cls.runWith({ tenantId: testTenantId, isSystemOperation: false }, () =>
      ticketsService.createTicket({
        title: 'Billing Issue 2',
        description: 'Refund request',
        priority: TicketPriority.HIGH,
        requiredSkills: ['billing'],
      }),
    );

    // Auto-route Ticket 2 (Agent A score 525 > Agent B score 450)
    const route2 = await routingService.autoRouteTicket(testTenantId, t2.id, ['billing']);
    expect(route2.routed).toBe(true);
    expect(route2.agentId).toBe(agentAId); // Agent A picked again

    // Agent A load is now 2/2 (100% capacity) -> Removed from ZSET
    const scoreAAfter2 = await routingRedisService.getAgentSkillScore(
      testTenantId,
      'billing',
      agentAId,
    );
    expect(scoreAAfter2).toBeNull(); // Removed because at max capacity
  });

  it('3. routes to next highest proficiency agent when top agent hits max capacity', async () => {
    // Create Ticket 3
    const t3 = await cls.runWith({ tenantId: testTenantId, isSystemOperation: false }, () =>
      ticketsService.createTicket({
        title: 'Billing Issue 3',
        description: 'Invoice discrepancy',
        priority: TicketPriority.HIGH,
        requiredSkills: ['billing'],
      }),
    );

    // Auto-route Ticket 3 (Agent A is full, Agent B is available)
    const route3 = await routingService.autoRouteTicket(testTenantId, t3.id, ['billing']);
    expect(route3.routed).toBe(true);
    expect(route3.agentId).toBe(agentBId);

    // Create Ticket 4
    const t4 = await cls.runWith({ tenantId: testTenantId, isSystemOperation: false }, () =>
      ticketsService.createTicket({
        title: 'Billing Issue 4',
        description: 'Payment failure',
        priority: TicketPriority.HIGH,
        requiredSkills: ['billing'],
      }),
    );

    // Auto-route Ticket 4 -> Agent B takes second ticket
    const route4 = await routingService.autoRouteTicket(testTenantId, t4.id, ['billing']);
    expect(route4.routed).toBe(true);
    expect(route4.agentId).toBe(agentBId);

    // Both Agent A and Agent B are now at max capacity (2/2)
    const scoreBAfter2 = await routingRedisService.getAgentSkillScore(
      testTenantId,
      'billing',
      agentBId,
    );
    expect(scoreBAfter2).toBeNull();
  });

  it('4. activates backpressure overflow pool when all skilled agents hit max capacity', async () => {
    // Create Ticket 5 with AUTO_PUSH mode
    const t5 = await cls.runWith({ tenantId: testTenantId, isSystemOperation: false }, () =>
      ticketsService.createTicket({
        title: 'Billing Issue 5 (Overflow)',
        description: 'Critical billing surge ticket',
        priority: TicketPriority.URGENT,
        routingMode: RoutingMode.AUTO_PUSH,
        requiredSkills: ['billing'],
      }),
    );

    // Attempt auto-routing when both agents are at 100% capacity
    const route5 = await routingService.autoRouteTicket(testTenantId, t5.id, ['billing']);
    expect(route5.routed).toBe(false);
    expect(route5.reason).toBe('CAPACITY_EXCEEDED_OVERFLOW');

    // Verify ticket remains OPEN in overflow pool
    const waitingTicket = await prisma.ticket.findUnique({
      where: { id: t5.id },
    });
    expect(waitingTicket!.status).toBe(TicketStatus.OPEN);
    expect(waitingTicket!.assignedAgentId).toBeNull();
    expect(waitingTicket!.routingMode).toBe(RoutingMode.AUTO_PUSH);
  });

  it('5. automatically drains overflow pool using SKIP LOCKED when agent frees capacity', async () => {
    // Agent A resolves one of their assigned tickets, freeing capacity
    const agentATickets = await prisma.ticket.findMany({
      where: {
        tenantId: testTenantId,
        assignedAgentId: agentAId,
        status: TicketStatus.ASSIGNED,
      },
    });
    expect(agentATickets.length).toBeGreaterThanOrEqual(1);
    const completedTicket = agentATickets[0]!;

    // Start work on ticket (ASSIGNED -> IN_PROGRESS)
    await cls.runWith({ tenantId: testTenantId, isSystemOperation: false }, () =>
      ticketsRepo.transitionTicketStatus({
        ticketId: completedTicket.id,
        targetStatus: TicketStatus.IN_PROGRESS,
        reason: 'Agent Alpha started working on ticket',
      }),
    );

    // Resolve ticket (IN_PROGRESS -> RESOLVED)
    await cls.runWith({ tenantId: testTenantId, isSystemOperation: false }, () =>
      ticketsRepo.transitionTicketStatus({
        ticketId: completedTicket.id,
        targetStatus: TicketStatus.RESOLVED,
        reason: 'Issue resolved by Agent Alpha',
      }),
    );

    // Trigger capacity freed handler
    const freedResult = await routingService.handleCapacityFreed(testTenantId, agentAId);

    expect(freedResult.assigned).toBe(true);
    expect(freedResult.ticketId).toBeDefined();

    // Verify the overflow ticket (Billing Issue 5) was claimed and assigned to Agent A
    const claimedTicket = await prisma.ticket.findUnique({
      where: { id: freedResult.ticketId },
    });
    expect(claimedTicket!.status).toBe(TicketStatus.ASSIGNED);
    expect(claimedTicket!.assignedAgentId).toBe(agentAId);
    expect(claimedTicket!.title).toBe('Billing Issue 5 (Overflow)');

    // Verify Agent A active load is still managed correctly
    const activeLoadA = await routingRedisService.getAgentActiveLoad(testTenantId, agentAId);
    expect(activeLoadA).toBe(2); // Was 2 -> freed to 1 -> claimed overflow to 2
  });
});
