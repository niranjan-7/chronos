import { Test, TestingModule } from '@nestjs/testing';
import { TicketPriority, TicketStatus } from '@prisma/client';
import { WarRoomEventListener } from './war-room-event.listener';
import { WarRoomGateway } from '../gateways/war-room.gateway';
import { PrismaService } from '../../../common/database/prisma.service';
import {
  SlaBreachedEvent,
  SlaWarningEvent,
  TicketTransitionedEvent,
} from '../../../common/events/ticket.events';

describe('WarRoomEventListener (Domain Event to WebSocket Bridge)', () => {
  let listener: WarRoomEventListener;
  let mockGateway: Partial<jest.Mocked<WarRoomGateway>>;
  let mockPrisma: any;

  const tenantId = '11111111-1111-1111-1111-111111111111';
  const ticketId = 'ticket-123';

  beforeEach(async () => {
    mockGateway = {
      broadcastSlaAlert: jest.fn(),
      broadcastAgentAssignment: jest.fn(),
      queueMetricsDelta: jest.fn(),
    };

    mockPrisma = {
      ticket: {
        findUnique: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WarRoomEventListener,
        {
          provide: WarRoomGateway,
          useValue: mockGateway,
        },
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
      ],
    }).compile();

    listener = module.get<WarRoomEventListener>(WarRoomEventListener);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('SLA Warning Bridge', () => {
    it('should query ticket details and broadcast SLA warning alert', async () => {
      mockPrisma.ticket.findUnique.mockResolvedValue({
        priority: TicketPriority.URGENT,
        status: TicketStatus.IN_PROGRESS,
        assignedAgentId: 'agent-1',
        ticketNumber: 'TCK-5001',
      });

      const event = new SlaWarningEvent(
        tenantId,
        ticketId,
        'TCK-5001',
        '2026-10-27T12:00:00.000Z',
        new Date('2026-10-27T11:45:00.000Z'),
      );

      await listener.handleSlaWarning(event);

      expect(mockPrisma.ticket.findUnique).toHaveBeenCalledWith({
        where: { id: ticketId },
        select: expect.any(Object),
      });

      expect(mockGateway.broadcastSlaAlert).toHaveBeenCalledWith(
        tenantId,
        expect.objectContaining({
          ticketId,
          ticketNumber: 'TCK-5001',
          priority: TicketPriority.URGENT,
          status: TicketStatus.IN_PROGRESS,
          type: 'WARNING',
        }),
      );
    });
  });

  describe('SLA Breach Bridge', () => {
    it('should query ticket and broadcast SLA breach alert with escalated priority', async () => {
      mockPrisma.ticket.findUnique.mockResolvedValue({
        status: TicketStatus.IN_PROGRESS,
        assignedAgentId: 'agent-2',
        ticketNumber: 'TCK-5002',
      });

      const event = new SlaBreachedEvent(
        tenantId,
        ticketId,
        'TCK-5002',
        TicketPriority.HIGH,
        TicketPriority.URGENT,
        new Date('2026-10-27T12:00:00.000Z'),
      );

      await listener.handleSlaBreached(event);

      expect(mockGateway.broadcastSlaAlert).toHaveBeenCalledWith(
        tenantId,
        expect.objectContaining({
          ticketId,
          ticketNumber: 'TCK-5002',
          priority: TicketPriority.URGENT,
          type: 'BREACH',
        }),
      );
    });
  });

  describe('Ticket Transition (Agent Assignment) Bridge', () => {
    it('should broadcast personal push-routed assignment when ticket transitions to ASSIGNED', async () => {
      mockPrisma.ticket.findUnique.mockResolvedValue({
        ticketNumber: 'TCK-777',
        priority: TicketPriority.HIGH,
        assignedAgentId: 'agent-42',
        requiredSkills: ['billing', 'rest_api'],
      });

      const event = new TicketTransitionedEvent(
        tenantId,
        ticketId,
        TicketStatus.OPEN,
        TicketStatus.ASSIGNED,
        'agent-42',
        'Auto push-routed by skill',
        new Date('2026-10-27T12:30:00.000Z'),
      );

      await listener.handleTicketTransitioned(event);

      expect(mockGateway.broadcastAgentAssignment).toHaveBeenCalledWith(
        tenantId,
        'agent-42',
        expect.objectContaining({
          ticketId,
          ticketNumber: 'TCK-777',
          priority: TicketPriority.HIGH,
          requiredSkills: ['billing', 'rest_api'],
        }),
      );
    });

    it('should not broadcast assignment if transition is not ASSIGNED', async () => {
      const event = new TicketTransitionedEvent(
        tenantId,
        ticketId,
        TicketStatus.ASSIGNED,
        TicketStatus.IN_PROGRESS,
        'agent-42',
        'Agent started working',
      );

      await listener.handleTicketTransitioned(event);

      expect(mockGateway.broadcastAgentAssignment).not.toHaveBeenCalled();
    });
  });

  describe('Metrics Mutation Bridge', () => {
    it('should extract metric increments and queue for throttled 250ms broadcast', () => {
      listener.handleMetricsMutated({
        tenantId,
        increments: {
          open_count: 1,
          at_risk_count: 2,
          breached_count: -1,
          total_tickets: 5,
        },
      });

      expect(mockGateway.queueMetricsDelta).toHaveBeenCalledWith(
        tenantId,
        expect.objectContaining({
          openCount: 1,
          atRiskCount: 2,
          breachedCount: -1,
          totalTickets: 5,
        }),
      );
    });
  });
});
