import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AgentStatus, TicketStatus, UserRole } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../common/database/prisma.service';
import { AppClsStore } from '../../common/context/app-cls.store';
import { CLS_TENANT_ID } from '../../common/constants/context.constants';
import { TicketsRepository } from '../tickets/repositories/tickets.repository';
import { RouteTicketDto } from './dto/route-ticket.dto';

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ticketsRepository: TicketsRepository,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  /**
   * Evaluates online agents, skill requirements, and active workloads to atomically
   * route and assign an incoming open ticket.
   */
  async matchAndRouteTicket(dto: RouteTicketDto) {
    const tenantId = this.cls.get(CLS_TENANT_ID);
    if (!tenantId) {
      throw new NotFoundException('Active tenant context required for routing.');
    }

    // 1. Fetch ticket and verify tenant
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

    // 2. Query eligible online agents ordered by lowest active workload
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

    // 3. Atomically transition ticket from OPEN to ASSIGNED with audit log
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
