import { TicketStateMachine } from './ticket-state-machine';
import { TicketStatus } from '@prisma/client';
import { InvalidStateTransitionException } from '../exceptions/invalid-state-transition.exception';

describe('TicketStateMachine', () => {
  let stateMachine: TicketStateMachine;

  beforeEach(() => {
    stateMachine = new TicketStateMachine();
  });

  describe('valid transitions', () => {
    it('should allow OPEN -> ASSIGNED', () => {
      expect(stateMachine.canTransition(TicketStatus.OPEN, TicketStatus.ASSIGNED)).toBe(true);
      expect(() =>
        stateMachine.validateTransition(TicketStatus.OPEN, TicketStatus.ASSIGNED),
      ).not.toThrow();
    });

    it('should allow ASSIGNED -> IN_PROGRESS', () => {
      expect(stateMachine.canTransition(TicketStatus.ASSIGNED, TicketStatus.IN_PROGRESS)).toBe(true);
    });

    it('should allow IN_PROGRESS -> ON_HOLD and ON_HOLD -> IN_PROGRESS', () => {
      expect(stateMachine.canTransition(TicketStatus.IN_PROGRESS, TicketStatus.ON_HOLD)).toBe(true);
      expect(stateMachine.canTransition(TicketStatus.ON_HOLD, TicketStatus.IN_PROGRESS)).toBe(true);
    });

    it('should allow IN_PROGRESS -> RESOLVED and RESOLVED -> CLOSED', () => {
      expect(stateMachine.canTransition(TicketStatus.IN_PROGRESS, TicketStatus.RESOLVED)).toBe(true);
      expect(stateMachine.canTransition(TicketStatus.RESOLVED, TicketStatus.CLOSED)).toBe(true);
    });

    it('should allow reopening RESOLVED -> IN_PROGRESS', () => {
      expect(stateMachine.canTransition(TicketStatus.RESOLVED, TicketStatus.IN_PROGRESS)).toBe(true);
    });
  });

  describe('invalid transitions', () => {
    it('should reject OPEN -> RESOLVED with structured InvalidStateTransitionException', () => {
      expect(stateMachine.canTransition(TicketStatus.OPEN, TicketStatus.RESOLVED)).toBe(false);

      try {
        stateMachine.validateTransition(TicketStatus.OPEN, TicketStatus.RESOLVED, 'tck-1');
        fail('Expected InvalidStateTransitionException to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidStateTransitionException);
        const response = (error as InvalidStateTransitionException).getResponse() as any;
        expect(response.error).toBe('InvalidStateTransition');
        expect(response.details.fromStatus).toBe(TicketStatus.OPEN);
        expect(response.details.toStatus).toBe(TicketStatus.RESOLVED);
        expect(response.details.allowedTransitions).toEqual([TicketStatus.ASSIGNED]);
      }
    });

    it('should reject OPEN -> CLOSED directly', () => {
      expect(stateMachine.canTransition(TicketStatus.OPEN, TicketStatus.CLOSED)).toBe(false);
    });

    it('should reject CLOSED -> any state (terminal)', () => {
      expect(stateMachine.canTransition(TicketStatus.CLOSED, TicketStatus.OPEN)).toBe(false);
      expect(stateMachine.canTransition(TicketStatus.CLOSED, TicketStatus.IN_PROGRESS)).toBe(false);
      expect(stateMachine.getAllowedTransitions(TicketStatus.CLOSED)).toEqual([]);
    });

    it('should reject self-transition (e.g. OPEN -> OPEN)', () => {
      expect(stateMachine.canTransition(TicketStatus.OPEN, TicketStatus.OPEN)).toBe(false);
    });
  });
});
