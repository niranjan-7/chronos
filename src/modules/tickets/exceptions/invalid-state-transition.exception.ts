import { BadRequestException } from '@nestjs/common';
import { TicketStatus } from '@prisma/client';

export interface StateTransitionErrorDetails {
  fromStatus: TicketStatus;
  toStatus: TicketStatus;
  allowedTransitions: TicketStatus[];
  ticketId?: string;
  reason?: string;
}

export class InvalidStateTransitionException extends BadRequestException {
  constructor(details: StateTransitionErrorDetails) {
    const allowedMsg =
      details.allowedTransitions.length > 0
        ? `[${details.allowedTransitions.join(', ')}]`
        : 'NONE (terminal state)';

    super({
      statusCode: 400,
      error: 'InvalidStateTransition',
      message: `Invalid state transition from '${details.fromStatus}' to '${details.toStatus}'. Allowed transitions from '${details.fromStatus}' are: ${allowedMsg}.`,
      details,
    });
  }
}
