import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  AGENT_CAPACITY_FREED_EVENT,
  TICKET_CREATED_EVENT,
} from '../../../common/events/domain-event.constants';
import {
  AgentCapacityFreedEvent,
  TicketCreatedEvent,
} from '../../../common/events/ticket.events';
import { RoutingService } from '../routing.service';
import { PrismaService } from '../../../common/database/prisma.service';
import { RoutingMode } from '@prisma/client';

@Injectable()
export class RoutingEventListener {
  private readonly logger = new Logger(RoutingEventListener.name);

  constructor(
    private readonly routingService: RoutingService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Automatically routes newly created tickets if routingMode is AUTO_PUSH.
   */
  @OnEvent(TICKET_CREATED_EVENT)
  async handleTicketCreated(event: TicketCreatedEvent): Promise<void> {
    try {
      const ticket = await this.prisma.ticket.findUnique({
        where: { id: event.ticketId },
      });

      if (ticket && ticket.routingMode === RoutingMode.AUTO_PUSH) {
        this.logger.debug(
          `[RoutingEventListener] Ticket ${ticket.ticketNumber} created with AUTO_PUSH. Triggering autoRouteTicket.`,
        );
        await this.routingService.autoRouteTicket(
          event.tenantId,
          event.ticketId,
          ticket.requiredSkills,
        );
      }
    } catch (err: any) {
      this.logger.error(`Error in handleTicketCreated routing: ${err.message}`, err.stack);
    }
  }

  /**
   * Whenever an agent resolves or pauses a ticket, capacity is freed.
   * Decrements Redis load, updates skill scores, and pulls waiting overflow tickets.
   */
  @OnEvent(AGENT_CAPACITY_FREED_EVENT)
  async handleAgentCapacityFreed(event: AgentCapacityFreedEvent): Promise<void> {
    try {
      this.logger.debug(
        `[RoutingEventListener] Capacity freed for agent ${event.agentId} in tenant ${event.tenantId}`,
      );
      await this.routingService.handleCapacityFreed(event.tenantId, event.agentId);
    } catch (err: any) {
      this.logger.error(`Error in handleAgentCapacityFreed routing: ${err.message}`, err.stack);
    }
  }
}
