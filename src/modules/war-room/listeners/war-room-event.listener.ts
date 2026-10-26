import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { TicketStatus } from '@prisma/client';
import {
  SLA_BREACHED_EVENT,
  SLA_WARNING_EVENT,
  TICKET_TRANSITIONED_EVENT,
} from '../../../common/events/domain-event.constants';
import {
  SlaBreachedEvent,
  SlaWarningEvent,
  TicketTransitionedEvent,
} from '../../../common/events/ticket.events';
import { PrismaService } from '../../../common/database/prisma.service';
import { WarRoomGateway } from '../gateways/war-room.gateway';
import { WarRoomMetricsDelta } from '../interfaces/war-room.interface';

@Injectable()
export class WarRoomEventListener {
  private readonly logger = new Logger(WarRoomEventListener.name);

  constructor(
    private readonly warRoomGateway: WarRoomGateway,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Bridges SLA Warning events to the War-Room tenant room.
   */
  @OnEvent(SLA_WARNING_EVENT)
  async handleSlaWarning(event: SlaWarningEvent): Promise<void> {
    try {
      const ticket = await this.prisma.ticket.findUnique({
        where: { id: event.ticketId },
        select: { priority: true, status: true, assignedAgentId: true, ticketNumber: true },
      });

      this.warRoomGateway.broadcastSlaAlert(event.tenantId, {
        ticketId: event.ticketId,
        ticketNumber: event.ticketNumber || ticket?.ticketNumber,
        priority: ticket?.priority || 'URGENT',
        status: ticket?.status || 'IN_PROGRESS',
        type: 'WARNING',
        warningAt: event.warningAt?.toISOString() || new Date().toISOString(),
        assignedAgentId: ticket?.assignedAgentId,
      });
    } catch (err: any) {
      this.logger.error(`Error broadcasting SLA warning to War Room: ${err.message}`);
    }
  }

  /**
   * Bridges SLA Breach events to the War-Room tenant room.
   */
  @OnEvent(SLA_BREACHED_EVENT)
  async handleSlaBreached(event: SlaBreachedEvent): Promise<void> {
    try {
      const ticket = await this.prisma.ticket.findUnique({
        where: { id: event.ticketId },
        select: { status: true, assignedAgentId: true, ticketNumber: true },
      });

      this.warRoomGateway.broadcastSlaAlert(event.tenantId, {
        ticketId: event.ticketId,
        ticketNumber: event.ticketNumber || ticket?.ticketNumber,
        priority: event.escalatedPriority || 'URGENT',
        status: ticket?.status || 'IN_PROGRESS',
        type: 'BREACH',
        breachedAt: event.breachedAt?.toISOString() || new Date().toISOString(),
        assignedAgentId: ticket?.assignedAgentId,
      });
    } catch (err: any) {
      this.logger.error(`Error broadcasting SLA breach to War Room: ${err.message}`);
    }
  }

  /**
   * Pushes personal ticket assignment events to tenant:{tenantId}:agent:{userId}.
   */
  @OnEvent(TICKET_TRANSITIONED_EVENT)
  async handleTicketTransitioned(event: TicketTransitionedEvent): Promise<void> {
    try {
      if (event.newStatus === TicketStatus.ASSIGNED) {
        const ticket = await this.prisma.ticket.findUnique({
          where: { id: event.ticketId },
          select: {
            ticketNumber: true,
            priority: true,
            assignedAgentId: true,
            requiredSkills: true,
          },
        });

        const agentId = ticket?.assignedAgentId || event.actorId;
        if (agentId) {
          this.warRoomGateway.broadcastAgentAssignment(event.tenantId, agentId, {
            ticketId: event.ticketId,
            ticketNumber: ticket?.ticketNumber || 'TCK-UNKNOWN',
            priority: ticket?.priority || 'HIGH',
            requiredSkills: ticket?.requiredSkills || [],
            assignedAt: event.transitionedAt?.toISOString() || new Date().toISOString(),
          });
        }
      }
    } catch (err: any) {
      this.logger.error(`Error broadcasting ticket assignment to agent room: ${err.message}`);
    }
  }

  /**
   * Whenever CQRS metrics mutate in Redis, queue the updated delta for throttled 250ms broadcast.
   */
  @OnEvent('metrics.mutated')
  handleMetricsMutated(event: { tenantId: string; increments: Record<string, number> }): void {
    const delta: WarRoomMetricsDelta = {};
    if (event.increments.open_count !== undefined) delta.openCount = event.increments.open_count;
    if (event.increments.at_risk_count !== undefined) delta.atRiskCount = event.increments.at_risk_count;
    if (event.increments.breached_count !== undefined) delta.breachedCount = event.increments.breached_count;
    if (event.increments.total_tickets !== undefined) delta.totalTickets = event.increments.total_tickets;
    if (event.increments.active_agents !== undefined) delta.activeAgents = event.increments.active_agents;

    this.warRoomGateway.queueMetricsDelta(event.tenantId, delta);
  }
}
