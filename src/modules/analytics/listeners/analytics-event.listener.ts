import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { TicketPriority, TicketStatus } from '@prisma/client';
import {
  SLA_BREACHED_EVENT,
  SLA_WARNING_EVENT,
  TICKET_CREATED_EVENT,
  TICKET_TRANSITIONED_EVENT,
} from '../../../common/events/domain-event.constants';
import {
  SlaBreachedEvent,
  SlaWarningEvent,
  TicketCreatedEvent,
  TicketTransitionedEvent,
} from '../../../common/events/ticket.events';
import { AnalyticsMetricsService } from '../services/analytics-metrics.service';
import { EventsGateway } from '../gateways/events.gateway';
import { WebhookDispatcherService } from '../services/webhook-dispatcher.service';

@Injectable()
export class AnalyticsEventListener {
  private readonly logger = new Logger(AnalyticsEventListener.name);

  constructor(
    private readonly metricsService: AnalyticsMetricsService,
    private readonly eventsGateway: EventsGateway,
    private readonly webhookDispatcher: WebhookDispatcherService,
  ) {}

  @OnEvent(TICKET_CREATED_EVENT)
  async handleTicketCreated(event: TicketCreatedEvent): Promise<void> {
    const { tenantId, ticketId, ticketNumber, priority } = event;

    // 1. Atomic Redis HINCRBY increments
    const priorityField = `priority_${priority.toLowerCase()}_count`;
    await this.metricsService.incrementMultiple(tenantId, {
      total_tickets: 1,
      open_count: 1,
      [priorityField]: 1,
    });

    const payload = {
      ticketId,
      ticketNumber,
      priority,
      createdAt: event.createdAt.toISOString(),
    };

    // 2. Broadcast live event to tenant WebSocket room
    this.eventsGateway.broadcastToTenant(tenantId, 'ticket.created', payload);

    // 3. Dispatch outbound webhooks
    await this.webhookDispatcher.dispatchEvent(tenantId, 'ticket.created', payload);
  }

  @OnEvent(TICKET_TRANSITIONED_EVENT)
  async handleTicketTransitioned(event: TicketTransitionedEvent): Promise<void> {
    const { tenantId, ticketId, previousStatus, newStatus, actorId, reason } = event;

    // 1. Update Redis live counters atomically (decrement previous, increment new)
    const prevField = `${previousStatus.toLowerCase()}_count`;
    const newField = `${newStatus.toLowerCase()}_count`;

    await this.metricsService.incrementMultiple(tenantId, {
      [prevField]: -1,
      [newField]: 1,
    });

    const payload = {
      ticketId,
      previousStatus,
      newStatus,
      actorId,
      reason,
      transitionedAt: event.transitionedAt.toISOString(),
    };

    // 2. If ticket was claimed/assigned, broadcast specific ticket.claimed event
    if (newStatus === TicketStatus.ASSIGNED) {
      this.eventsGateway.broadcastTicketClaimed(tenantId, payload);
      await this.webhookDispatcher.dispatchEvent(tenantId, 'ticket.claimed', payload);
    }

    // 3. Broadcast general transition to WebSocket and Webhooks
    this.eventsGateway.broadcastToTenant(tenantId, 'ticket.transitioned', payload);
    await this.webhookDispatcher.dispatchEvent(tenantId, 'ticket.transitioned', payload);
  }

  @OnEvent(SLA_WARNING_EVENT)
  async handleSlaWarning(event: SlaWarningEvent): Promise<void> {
    const { tenantId, ticketId, ticketNumber, targetDeadline } = event;

    // 1. Atomic Redis HINCRBY for at-risk tickets
    await this.metricsService.increment(tenantId, 'at_risk_count', 1);

    const payload = {
      ticketId,
      ticketNumber,
      targetDeadline,
      warningAt: event.warningAt.toISOString(),
    };

    // 2. Broadcast to WebSocket
    this.eventsGateway.broadcastSlaWarning(tenantId, payload);

    // 3. Dispatch outbound webhook
    await this.webhookDispatcher.dispatchEvent(tenantId, 'sla.warning', payload);
  }

  @OnEvent(SLA_BREACHED_EVENT)
  async handleSlaBreached(event: SlaBreachedEvent): Promise<void> {
    const { tenantId, ticketId, ticketNumber, originalPriority, escalatedPriority } = event;

    // 1. Update Redis counters: breached_count + 1 and priority breakdown shift
    const increments: Record<string, number> = {
      breached_count: 1,
    };

    if (originalPriority !== escalatedPriority) {
      increments[`priority_${originalPriority.toLowerCase()}_count`] = -1;
      increments[`priority_${escalatedPriority.toLowerCase()}_count`] = 1;
    }

    await this.metricsService.incrementMultiple(tenantId, increments);

    const payload = {
      ticketId,
      ticketNumber,
      originalPriority,
      escalatedPriority,
      breachedAt: event.breachedAt.toISOString(),
    };

    // 2. Broadcast live event to WebSocket
    this.eventsGateway.broadcastSlaBreached(tenantId, payload);

    // 3. Dispatch outbound webhook
    await this.webhookDispatcher.dispatchEvent(tenantId, 'sla.breached', payload);
  }
}
