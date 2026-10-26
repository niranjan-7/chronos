import { PrismaClient, TicketPriority, TicketStatus, UserRole } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { AsyncLocalStorage } from 'async_hooks';
import { TicketsRepository } from '../src/modules/tickets/repositories/tickets.repository';
import { TicketStateMachine } from '../src/modules/tickets/state-machine/ticket-state-machine';
import { PrismaService } from '../src/common/database/prisma.service';
import { AppClsStore } from '../src/common/context/app-cls.store';
import { ConflictException } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

describe('Atomic Ticket Claim Engine (SKIP LOCKED Concurrency Proof)', () => {
  let prisma: PrismaService;
  let cls: ClsService<AppClsStore>;
  let stateMachine: TicketStateMachine;
  let repository: TicketsRepository;

  let testTenantId: string;
  const testTenantSlug = `tenant-concurrency-${Date.now()}`;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();

    const als = new AsyncLocalStorage();
    cls = new ClsService<AppClsStore>(als);
    stateMachine = new TicketStateMachine();
    repository = new TicketsRepository(prisma, cls, stateMachine);

    // Create isolated tenant for this concurrency test run
    const tenant = await prisma.tenant.create({
      data: {
        name: 'Concurrency Test Tenant',
        slug: testTenantSlug,
      },
    });
    testTenantId = tenant.id;
  });

  afterAll(async () => {
    // Clean up tenant and cascaded records
    if (testTenantId) {
      await prisma.tenant.delete({
        where: { id: testTenantId },
      });
    }
    await prisma.$disconnect();
  });

  it('proves that 20 concurrent agents claiming 10 tickets yields zero collisions, exactly 10 successes and 10 graceful skips', async () => {
    // 1. Provision 20 distinct agents
    const agents = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        prisma.user.create({
          data: {
            tenantId: testTenantId,
            email: `agent-${i + 1}-${Date.now()}@chronos.io`,
            name: `Agent ${i + 1}`,
            role: UserRole.AGENT,
          },
        }),
      ),
    );

    // 2. Seed 10 OPEN tickets with varied priorities
    const priorities: TicketPriority[] = [
      TicketPriority.URGENT,
      TicketPriority.URGENT,
      TicketPriority.HIGH,
      TicketPriority.HIGH,
      TicketPriority.HIGH,
      TicketPriority.MEDIUM,
      TicketPriority.MEDIUM,
      TicketPriority.LOW,
      TicketPriority.LOW,
      TicketPriority.LOW,
    ];

    const tickets = await Promise.all(
      priorities.map((priority, index) =>
        prisma.ticket.create({
          data: {
            tenantId: testTenantId,
            ticketNumber: `CONCUR-${(index + 1).toString().padStart(4, '0')}`,
            title: `Concurrent Test Ticket #${index + 1}`,
            description: `Testing SKIP LOCKED under heavy concurrency`,
            status: TicketStatus.OPEN,
            priority,
          },
        }),
      ),
    );

    expect(tickets.length).toBe(10);

    // 3. Fire 20 SIMULTANEOUS non-blocking claim requests via Promise.all
    const startTime = Date.now();
    const claimResults = await Promise.all(
      agents.map((agent) =>
        repository.withTenant(testTenantId, () =>
          repository.claimNextTicket(agent.id),
        ),
      ),
    );
    const duration = Date.now() - startTime;

    console.log(`[CONCURRENCY PROOF] 20 concurrent claims completed in ${duration}ms`);

    // 4. Assertions on the claim results
    const successfulClaims = claimResults.filter((r) => r.claimed && r.ticket);
    const skippedClaims = claimResults.filter((r) => !r.claimed);

    // Exactly 10 tickets were available, so exactly 10 must succeed
    expect(successfulClaims.length).toBe(10);
    // Exactly 10 agents found no tickets left (skipped without error or deadlock)
    expect(skippedClaims.length).toBe(10);

    // 5. Verify ZERO collisions across claimed ticket IDs
    const claimedTicketIds = successfulClaims.map((r) => r.ticket!.id);
    const uniqueClaimedTicketIds = new Set(claimedTicketIds);
    expect(uniqueClaimedTicketIds.size).toBe(10);

    // 6. Verify ZERO collisions across assigned agent IDs
    const assignedAgentIds = successfulClaims.map((r) => r.ticket!.assignedAgentId);
    const uniqueAgentIds = new Set(assignedAgentIds);
    expect(uniqueAgentIds.size).toBe(10);

    // 7. Verify all 10 tickets in the DB are now ASSIGNED
    const dbTickets = await prisma.ticket.findMany({
      where: { tenantId: testTenantId },
    });
    expect(dbTickets.every((t) => t.status === TicketStatus.ASSIGNED)).toBe(true);

    // 8. Verify audit logs in the database
    const auditLogs = await prisma.ticketAuditLog.findMany({
      where: { tenantId: testTenantId, action: 'TICKET_CLAIMED_NEXT' },
    });
    expect(auditLogs.length).toBe(10);

    const auditedTicketIds = new Set(auditLogs.map((log) => log.ticketId));
    expect(auditedTicketIds.size).toBe(10);
  });

  it('proves that 10 concurrent agents racing for the EXACT SAME ticket results in 1 winner and 9 rejected without race conditions', async () => {
    // 1. Provision 10 agents
    const agents = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        prisma.user.create({
          data: {
            tenantId: testTenantId,
            email: `race-agent-${i + 1}-${Date.now()}@chronos.io`,
            name: `Race Agent ${i + 1}`,
            role: UserRole.AGENT,
          },
        }),
      ),
    );

    // 2. Create single high-demand ticket
    const hotTicket = await prisma.ticket.create({
      data: {
        tenantId: testTenantId,
        ticketNumber: `HOT-TICKET-${Date.now()}`,
        title: 'Single Hot Ticket',
        description: 'Target of 10 concurrent claim attempts',
        status: TicketStatus.OPEN,
        priority: TicketPriority.URGENT,
      },
    });

    // 3. Fire 10 simultaneous claim requests for the specific ticket ID
    const results = await Promise.allSettled(
      agents.map((agent) =>
        repository.withTenant(testTenantId, () =>
          repository.claimSpecificTicket(hotTicket.id, agent.id),
        ),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly 1 winner
    expect(fulfilled.length).toBe(1);
    // Exactly 9 conflict rejections
    expect(rejected.length).toBe(9);

    // Verify rejection reasons are ConflictException
    rejected.forEach((r) => {
      const reason = (r as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(ConflictException);
    });

    // Verify DB ticket state is assigned to the 1 winner
    const updatedInDb = await prisma.ticket.findUnique({
      where: { id: hotTicket.id },
    });
    expect(updatedInDb!.status).toBe(TicketStatus.ASSIGNED);

    const winner = (fulfilled[0] as PromiseFulfilledResult<any>).value;
    expect(updatedInDb!.assignedAgentId).toBe(winner.assignedAgentId);
  });
});
