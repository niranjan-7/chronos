import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WarRoomGateway } from './war-room.gateway';
import * as jwt from 'jsonwebtoken';

describe('WarRoomGateway (Real-Time Multi-Tenant Telemetry Gateway)', () => {
  let gateway: WarRoomGateway;
  const mockJwtSecret = 'chronos-super-secret-jwt-key-32-chars-min!';
  const tenantId = '11111111-1111-1111-1111-111111111111';
  const userId = 'user-agent-99';

  let mockServer: any;
  let mockSocket: any;

  beforeEach(async () => {
    jest.useFakeTimers();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WarRoomGateway,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: any) => {
              if (key === 'JWT_SECRET') return mockJwtSecret;
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();

    gateway = module.get<WarRoomGateway>(WarRoomGateway);

    mockServer = {
      to: jest.fn().mockReturnThis(),
      emit: jest.fn(),
    };
    gateway.server = mockServer as any;

    mockSocket = {
      id: 'socket-test-123',
      handshake: {
        auth: {},
        headers: {},
        query: {},
      },
      data: {},
      join: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
    };
  });

  afterEach(() => {
    gateway.flushAllMetrics();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe('Multi-Tenant Handshake Authentication & Room Isolation', () => {
    it('should authenticate client with valid JWT in handshake.auth.token and join tenant & agent rooms', () => {
      const token = jwt.sign(
        { tenantId, sub: userId, role: 'AGENT' },
        mockJwtSecret,
        { expiresIn: '1h' },
      );
      mockSocket.handshake.auth.token = token;

      gateway.handleConnection(mockSocket);

      expect(mockSocket.join).toHaveBeenCalledWith(`tenant:${tenantId}:war-room`);
      expect(mockSocket.join).toHaveBeenCalledWith(`tenant:${tenantId}:agent:${userId}`);
      expect(mockSocket.data.tenantId).toBe(tenantId);
      expect(mockSocket.data.userId).toBe(userId);
      expect(mockSocket.data.role).toBe('AGENT');
      expect(mockSocket.emit).toHaveBeenCalledWith(
        'authenticated',
        expect.objectContaining({
          status: 'CONNECTED',
          tenantId,
          userId,
        }),
      );
      expect(mockSocket.disconnect).not.toHaveBeenCalled();
    });

    it('should authenticate client when token is in authorization header', () => {
      const token = jwt.sign(
        { tenant_id: tenantId, userId, roles: ['DISPATCHER'] },
        mockJwtSecret,
      );
      mockSocket.handshake.headers['authorization'] = `Bearer ${token}`;

      gateway.handleConnection(mockSocket);

      expect(mockSocket.join).toHaveBeenCalledWith(`tenant:${tenantId}:war-room`);
      expect(mockSocket.join).toHaveBeenCalledWith(`tenant:${tenantId}:agent:${userId}`);
      expect(mockSocket.data.role).toBe('DISPATCHER');
      expect(mockSocket.disconnect).not.toHaveBeenCalled();
    });

    it('should authenticate client when token is in query params', () => {
      const token = jwt.sign(
        { tenantId, sub: userId, role: 'ADMIN' },
        mockJwtSecret,
      );
      mockSocket.handshake.query.token = token;

      gateway.handleConnection(mockSocket);

      expect(mockSocket.join).toHaveBeenCalledWith(`tenant:${tenantId}:war-room`);
      expect(mockSocket.disconnect).not.toHaveBeenCalled();
    });

    it('should reject and disconnect client if token is missing', () => {
      gateway.handleConnection(mockSocket);

      expect(mockSocket.emit).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({
          message: expect.stringContaining('Authentication required'),
        }),
      );
      expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
      expect(mockSocket.join).not.toHaveBeenCalled();
    });

    it('should reject and disconnect client if token is invalid or expired', () => {
      mockSocket.handshake.auth.token = 'invalid.jwt.token';

      gateway.handleConnection(mockSocket);

      expect(mockSocket.emit).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({
          message: expect.stringContaining('Unauthorized'),
        }),
      );
      expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
      expect(mockSocket.join).not.toHaveBeenCalled();
    });

    it('should reject token that lacks tenantId claim', () => {
      const token = jwt.sign({ sub: userId }, mockJwtSecret);
      mockSocket.handshake.auth.token = token;

      gateway.handleConnection(mockSocket);

      expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
    });
  });

  describe('Event-Driven Broadcasts', () => {
    it('should broadcast SLA warning to tenant war-room', () => {
      gateway.broadcastSlaAlert(tenantId, {
        ticketId: 'tck-1',
        ticketNumber: 'TCK-1001',
        priority: 'URGENT',
        status: 'IN_PROGRESS',
        type: 'WARNING',
        warningAt: '2026-10-27T10:00:00.000Z',
      });

      expect(mockServer.to).toHaveBeenCalledWith(`tenant:${tenantId}:war-room`);
      expect(mockServer.emit).toHaveBeenCalledWith(
        'sla.warning',
        expect.objectContaining({
          event: 'sla.warning',
          ticketId: 'tck-1',
          ticketNumber: 'TCK-1001',
          priority: 'URGENT',
        }),
      );
    });

    it('should broadcast SLA breach to tenant war-room', () => {
      gateway.broadcastSlaAlert(tenantId, {
        ticketId: 'tck-2',
        ticketNumber: 'TCK-1002',
        priority: 'CRITICAL',
        status: 'OPEN',
        type: 'BREACH',
        breachedAt: '2026-10-27T10:30:00.000Z',
      });

      expect(mockServer.to).toHaveBeenCalledWith(`tenant:${tenantId}:war-room`);
      expect(mockServer.emit).toHaveBeenCalledWith(
        'sla.breach',
        expect.objectContaining({
          event: 'sla.breach',
          ticketId: 'tck-2',
          ticketNumber: 'TCK-1002',
        }),
      );
    });

    it('should broadcast personal agent assignment to agent room', () => {
      gateway.broadcastAgentAssignment(tenantId, 'agent-42', {
        ticketId: 'tck-3',
        ticketNumber: 'TCK-1003',
        priority: 'HIGH',
        requiredSkills: ['voice_webrtc'],
        assignedAt: '2026-10-27T11:00:00.000Z',
      });

      expect(mockServer.to).toHaveBeenCalledWith(`tenant:${tenantId}:agent:agent-42`);
      expect(mockServer.emit).toHaveBeenCalledWith(
        'ticket.assigned',
        expect.objectContaining({
          event: 'ticket.assigned',
          ticketId: 'tck-3',
          ticketNumber: 'TCK-1003',
          agentId: 'agent-42',
          requiredSkills: ['voice_webrtc'],
        }),
      );
    });
  });

  describe('Debounced / Throttled Metrics Broadcast (250ms Rate-Limit)', () => {
    it('should broadcast initial metrics delta immediately', () => {
      gateway.queueMetricsDelta(tenantId, { openCount: 1, totalTickets: 1 });

      expect(mockServer.to).toHaveBeenCalledWith(`tenant:${tenantId}:war-room`);
      expect(mockServer.emit).toHaveBeenCalledWith(
        'metrics.updated',
        expect.objectContaining({
          tenantId,
          delta: expect.objectContaining({ openCount: 1, totalTickets: 1 }),
        }),
      );
    });

    it('should accumulate rapid metrics changes and debounce into a single broadcast after 250ms', () => {
      // First event triggers immediate broadcast
      gateway.queueMetricsDelta(tenantId, { openCount: 1, totalTickets: 1 });
      expect(mockServer.emit).toHaveBeenCalledTimes(1);

      // Subsequent 3 rapid bursts within 250ms
      gateway.queueMetricsDelta(tenantId, { openCount: 2, breachedCount: 1 });
      gateway.queueMetricsDelta(tenantId, { openCount: -1, atRiskCount: 3 });
      gateway.queueMetricsDelta(tenantId, { totalTickets: 2 });

      // Shouldn't have broadcasted again yet
      expect(mockServer.emit).toHaveBeenCalledTimes(1);

      // Advance clock past 250ms debounce window
      jest.advanceTimersByTime(260);

      // Now exactly second broadcast should have occurred with merged deltas:
      // openCount: 2 + (-1) = 1
      // breachedCount: 1
      // atRiskCount: 3
      // totalTickets: 2
      expect(mockServer.emit).toHaveBeenCalledTimes(2);
      expect(mockServer.emit).toHaveBeenLastCalledWith(
        'metrics.updated',
        expect.objectContaining({
          tenantId,
          delta: expect.objectContaining({
            openCount: 1,
            breachedCount: 1,
            atRiskCount: 3,
            totalTickets: 2,
          }),
        }),
      );
    });

    it('should flush all metrics cleanly during gateway teardown', () => {
      gateway.queueMetricsDelta(tenantId, { openCount: 1 });
      gateway.queueMetricsDelta(tenantId, { openCount: 5 }); // Queued in debounce timer

      gateway.flushAllMetrics();

      expect(mockServer.emit).toHaveBeenCalledTimes(2);
    });
  });
});
