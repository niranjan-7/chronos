import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AgentStatus, RoutingMode, TicketPriority, TicketStatus, UserRole } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../common/database/prisma.service';
import { AppClsStore } from '../../common/context/app-cls.store';
import { CLS_TENANT_ID } from '../../common/constants/context.constants';
import { TicketsRepository } from '../tickets/repositories/tickets.repository';
import { RouteTicketDto } from './dto/route-ticket.dto';
import { RoutingRedisService } from './services/routing-redis.service';

interface WaitingTicketRow {
  id: string;
  ticket_number: string;
  priority: TicketPriority;
  required_skills: string[];
}

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ticketsRepository: TicketsRepository,
    private readonly cls: ClsService<AppClsStore>,
    private readonly routingRedisService: RoutingRedisService,
  ) {}

  /**
   * Helper to ensure operation runs within the tenant's CLS context.
   */
  private async withTenantContext<T>(
    tenantId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const activeTenantId = this.cls.get(CLS_TENANT_ID);
    if (activeTenantId === tenantId) {
      return operation();
    }
    return this.cls.runWith(
      {
        tenantId,
        isSystemOperation: true,
      },
      operation,
    );
  }

  /**
   * Registers or updates an agent's specialization skills and syncs their composite
   * scores into Redis skill ZSETs.
   */
  async registerAgentSkills(
    tenantId: string,
    agentId: string,
    skills: { skill: string; proficiency: number }[],
    maxCapacity?: number,
  ): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { id: agentId, tenantId },
    });
    if (!user) {
      throw new NotFoundException(`Agent '${agentId}' not found in current tenant.`);
    }

    if (maxCapacity !== undefined) {
      await this.prisma.user.update({
        where: { id: agentId },
        data: { maxConcurrentTickets: maxCapacity },
      });
    }

    // Upsert skills in PostgreSQL
    for (const s of skills) {
      await this.prisma.agentSkill.upsert({
        where: {
          uq_agent_skill: { agentId, skill: s.skill },
        },
        create: {
          tenantId,
          agentId,
          skill: s.skill,
          proficiency: s.proficiency,
        },
        update: {
          proficiency: s.proficiency,
        },
      });
    }

    const allSkills = await this.prisma.agentSkill.findMany({
      where: { agentId, tenantId },
    });

    const effectiveMaxCapacity = maxCapacity ?? user.maxConcurrentTickets ?? 5;

    // Sync to Redis live structures
    await this.routingRedisService.syncAgentProfile(tenantId, agentId, {
      status: user.status,
      maxCapacity: effectiveMaxCapacity,
      skills: allSkills.map((s) => ({ skill: s.skill, proficiency: s.proficiency })),
    });

    this.logger.log(
      `[RoutingService] Registered ${skills.length} skills for agent ${agentId} in tenant ${tenantId}`,
    );
  }

  /**
   * Updates an agent's live status (ONLINE, BUSY, OFFLINE) and syncs Redis ZSETs.
   * If agent transitions to ONLINE, checks for and drains waiting overflow tickets.
   */
  async updateAgentStatus(
    tenantId: string,
    agentId: string,
    status: AgentStatus,
  ): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { id: agentId, tenantId },
      include: { agentSkills: true },
    });
    if (!user) {
      throw new NotFoundException(`Agent '${agentId}' not found in current tenant.`);
    }

    await this.prisma.user.update({
      where: { id: agentId },
      data: { status },
    });

    await this.routingRedisService.syncAgentProfile(tenantId, agentId, {
      status,
      maxCapacity: user.maxConcurrentTickets,
      skills: user.agentSkills.map((s) => ({ skill: s.skill, proficiency: s.proficiency })),
    });

    this.logger.log(`[RoutingService] Agent ${agentId} status updated to ${status}`);

    if (status === AgentStatus.ONLINE) {
      // Drain waiting overflow tickets if capacity permits
      await this.handleCapacityFreed(tenantId, agentId);
    }
  }

  /**
   * High-Throughput Auto-Push Routing via atomic Redis Lua Script (claim_best_agent.lua).
   * Atomically claims candidate agent from required skill ZSET or pushes to overflow queue on backpressure.
   */
  async autoRouteTicket(
    tenantId: string,
    ticketId: string,
    requiredSkills?: string[],
  ): Promise<{ routed: boolean; agentId?: string; reason?: string; ticketId: string }> {
    return this.withTenantContext(tenantId, async () => {
      const ticket = await this.prisma.ticket.findFirst({
        where: { id: ticketId, tenantId },
      });
      if (!ticket) {
        throw new NotFoundException(`Ticket '${ticketId}' not found.`);
      }

      if (ticket.status !== TicketStatus.OPEN) {
        return {
          routed: false,
          reason: `Ticket status is '${ticket.status}', expected 'OPEN'.`,
          ticketId,
        };
      }

      const skills = requiredSkills && requiredSkills.length > 0 ? requiredSkills : ticket.requiredSkills;
      const primarySkill = skills.length > 0 ? skills[0] : 'general';

      // 1. Atomically claim best candidate via Redis Lua script
      const winningAgentId = await this.routingRedisService.claimBestAgent(tenantId, primarySkill);

      if (winningAgentId) {
        // 2. Winner found: atomically transition ticket in DB
        await this.ticketsRepository.transitionTicketStatus({
          ticketId: ticket.id,
          targetStatus: TicketStatus.ASSIGNED,
          assignedAgentId: winningAgentId,
          reason: `Auto-routed via skill ZSET [${primarySkill}] and atomic Redis Lua claim`,
        });

        this.logger.log(
          `[RoutingService] Ticket ${ticket.ticketNumber} auto-routed to best agent ${winningAgentId} (Skill: ${primarySkill})`,
        );

        return {
          routed: true,
          agentId: winningAgentId,
          ticketId: ticket.id,
        };
      }

      // 3. Backpressure / Overflow Fallback:
      // All matching agents are at 100% capacity or offline. Ticket remains OPEN in overflow queue.
      await this.prisma.ticket.update({
        where: { id: ticket.id },
        data: {
          routingMode: RoutingMode.AUTO_PUSH,
        },
      });

      this.logger.warn(
        `[RoutingService BACKPRESSURE] All agents matching skill [${primarySkill}] are at max capacity or offline. Ticket ${ticket.ticketNumber} retained in OPEN overflow queue.`,
      );

      return {
        routed: false,
        reason: 'CAPACITY_EXCEEDED_OVERFLOW',
        ticketId: ticket.id,
      };
    });
  }

  /**
   * Handles capacity freed when an agent completes or pauses a ticket.
   * Decrements Redis load, recalculates ZSET scores, and pulls highest-priority
   * waiting overflow ticket matching agent skills using SELECT ... FOR UPDATE SKIP LOCKED.
   */
  async handleCapacityFreed(
    tenantId: string,
    agentId: string,
  ): Promise<{ assigned: boolean; ticketId?: string; reason?: string }> {
    return this.withTenantContext(tenantId, async () => {
      // 1. Decrement load and restore candidate score in Redis
      const newLoad = await this.routingRedisService.freeAgentCapacity(tenantId, agentId);

      this.logger.debug(
        `[RoutingService] Agent ${agentId} capacity freed (New active load: ${newLoad})`,
      );

      // 2. Fetch agent's skills from PostgreSQL
      const agentSkills = await this.prisma.agentSkill.findMany({
        where: { agentId, tenantId },
      });
      const skillNames = agentSkills.map((s) => s.skill);

      // 3. Atomically query and lock highest-priority waiting ticket matching agent skills
      const candidates = await this.prisma.$queryRaw<WaitingTicketRow[]>`
        SELECT t.id, t.ticket_number, t.priority, t.required_skills
        FROM tickets t
        WHERE t.tenant_id = ${tenantId}::uuid
          AND t.status = 'OPEN'::"TicketStatus"
          AND t.routing_mode = 'AUTO_PUSH'::"RoutingMode"
          AND t.assigned_agent_id IS NULL
          AND (
            cardinality(t.required_skills) = 0
            OR t.required_skills && ${skillNames}::text[]
          )
        ORDER BY
          CASE t.priority
            WHEN 'URGENT' THEN 1
            WHEN 'HIGH' THEN 2
            WHEN 'MEDIUM' THEN 3
            WHEN 'LOW' THEN 4
            ELSE 5
          END ASC,
          t.created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED;
      `;

      if (!candidates || candidates.length === 0) {
        return {
          assigned: false,
          reason: 'NO_WAITING_OVERFLOW_TICKETS',
        };
      }

      const waitingTicket = candidates[0];

      // 4. Assign waiting ticket to agent
      await this.ticketsRepository.transitionTicketStatus({
        ticketId: waitingTicket.id,
        targetStatus: TicketStatus.ASSIGNED,
        assignedAgentId: agentId,
        reason: `Auto-assigned from overflow pool on capacity freed (Priority: ${waitingTicket.priority})`,
      });

      // 5. Re-increment agent active load in Redis
      await this.routingRedisService.incrementAgentLoad(tenantId, agentId);

      this.logger.log(
        `[RoutingService OVERFLOW PULL] Ticket ${waitingTicket.ticket_number} [${waitingTicket.priority}] auto-assigned to agent ${agentId} on freed capacity`,
      );

      return {
        assigned: true,
        ticketId: waitingTicket.id,
      };
    });
  }

  /**
   * Legacy workload-based route matcher for backwards-compatibility with Phase 2 tests.
   */
  async matchAndRouteTicket(dto: RouteTicketDto) {
    const tenantId = this.cls.get(CLS_TENANT_ID);
    if (!tenantId) {
      throw new NotFoundException('Active tenant context required for routing.');
    }

    const ticket = await this.ticketsRepository.findById(dto.ticketId);
    if (!ticket) {
      throw new NotFoundException(`Ticket '${dto.ticketId}' not found in current tenant.`);
    }

    if (ticket.status !== TicketStatus.OPEN) {
      return {
        ticketId: ticket.id,
        routed: false,
        reason: `Ticket cannot be routed: Current status is '${ticket.status}', expected 'OPEN'.`,
      };
    }

    const eligibleAgents = await this.prisma.user.findMany({
      where: {
        tenantId,
        role: { in: [UserRole.AGENT, UserRole.SUPERVISOR] },
        status: AgentStatus.ONLINE,
        ...(dto.requiredSkills && dto.requiredSkills.length > 0
          ? { skills: { hasSome: dto.requiredSkills } }
          : {}),
      },
      include: {
        _count: {
          select: {
            assignedTickets: {
              where: {
                status: { in: [TicketStatus.ASSIGNED, TicketStatus.IN_PROGRESS] },
              },
            },
          },
        },
      },
      orderBy: {
        assignedTickets: {
          _count: 'asc',
        },
      },
    });

    if (eligibleAgents.length === 0) {
      this.logger.warn(`No online agents available for routing ticket ${ticket.ticketNumber}`);
      return {
        ticketId: ticket.id,
        routed: false,
        reason: 'NO_ONLINE_AGENTS_AVAILABLE',
      };
    }

    const targetAgent = eligibleAgents[0];

    const updatedTicket = await this.ticketsRepository.transitionTicketStatus({
      ticketId: ticket.id,
      targetStatus: TicketStatus.ASSIGNED,
      reason: `Automated event-driven routing based on lowest workload (${targetAgent._count.assignedTickets} active tickets)`,
      assignedAgentId: targetAgent.id,
    });

    return {
      ticketId: updatedTicket.id,
      routed: true,
      assignedAgent: {
        id: targetAgent.id,
        name: targetAgent.name,
        email: targetAgent.email,
        workload: targetAgent._count.assignedTickets + 1,
      },
    };
  }
}
