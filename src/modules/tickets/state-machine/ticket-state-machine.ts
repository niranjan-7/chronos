import { Injectable, Logger } from '@nestjs/common';
import { TicketStatus } from '@prisma/client';
import { InvalidStateTransitionException } from '../exceptions/invalid-state-transition.exception';

/**
 * Strict Ticket State Machine enforcing allowed lifecycle transitions:
 * OPEN -> ASSIGNED -> IN_PROGRESS -> ON_HOLD -> RESOLVED -> CLOSED
 */
@Injectable()
export class TicketStateMachine {
  private readonly logger = new Logger(TicketStateMachine.name);

  /**
   * Directed Acyclic Graph (DAG) / state transition matrix of allowed transitions.
   */
  private static readonly TRANSITION_MATRIX: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
    [TicketStatus.OPEN]: [
      TicketStatus.ASSIGNED,
    ],
    [TicketStatus.ASSIGNED]: [
      TicketStatus.IN_PROGRESS,
      TicketStatus.OPEN, // If unassigned/released back to pool
    ],
    [TicketStatus.IN_PROGRESS]: [
      TicketStatus.ON_HOLD,
      TicketStatus.RESOLVED,
      TicketStatus.ASSIGNED, // If reassigned while in progress
    ],
    [TicketStatus.ON_HOLD]: [
      TicketStatus.IN_PROGRESS,
      TicketStatus.RESOLVED,
      TicketStatus.OPEN, // If unassigned and returned to queue
    ],
    [TicketStatus.RESOLVED]: [
      TicketStatus.CLOSED,
      TicketStatus.IN_PROGRESS, // If reopened by customer / supervisor
    ],
    [TicketStatus.CLOSED]: [], // Terminal state, no transitions permitted
  };

  /**
   * Retrieves the allowed target states from the current status.
   */
  getAllowedTransitions(currentStatus: TicketStatus): readonly TicketStatus[] {
    return TicketStateMachine.TRANSITION_MATRIX[currentStatus] || [];
  }

  /**
   * Checks if a transition from `currentStatus` to `targetStatus` is permitted.
   */
  canTransition(currentStatus: TicketStatus, targetStatus: TicketStatus): boolean {
    if (currentStatus === targetStatus) {
      return false;
    }
    const allowed = this.getAllowedTransitions(currentStatus);
    return allowed.includes(targetStatus);
  }

  /**
   * Validates a state transition and throws a structured `InvalidStateTransitionException` if invalid.
   */
  validateTransition(
    currentStatus: TicketStatus,
    targetStatus: TicketStatus,
    ticketId?: string,
    reason?: string,
  ): void {
    if (!this.canTransition(currentStatus, targetStatus)) {
      const allowed = this.getAllowedTransitions(currentStatus);
      this.logger.warn(
        `Rejected illegal ticket state transition: ${currentStatus} -> ${targetStatus} (ticketId: ${ticketId ?? 'unknown'})`,
      );
      throw new InvalidStateTransitionException({
        fromStatus: currentStatus,
        toStatus: targetStatus,
        allowedTransitions: [...allowed],
        ticketId,
        reason,
      });
    }
  }
}
