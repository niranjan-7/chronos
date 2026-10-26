import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import * as jwt from 'jsonwebtoken';
import {
  AgentAssignmentPayload,
  SlaWarRoomAlert,
  WarRoomAuthData,
  WarRoomMetricsDelta,
} from '../interfaces/war-room.interface';

@WebSocketGateway({
  namespace: '/war-room',
  cors: {
    origin: '*',
  },
})
export class WarRoomGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(WarRoomGateway.name);
  private readonly jwtSecret: string;

  // Debouncing / Throttling state per tenant (250ms rate-limit)
  private readonly pendingDeltas = new Map<string, WarRoomMetricsDelta>();
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly lastBroadcastTimes = new Map<string, number>();

  @WebSocketServer()
  server!: Server;

  constructor(private readonly config: ConfigService) {
    this.jwtSecret =
      this.config.get<string>('JWT_SECRET') ||
      'chronos-super-secret-jwt-key-32-chars-min!';
  }

  /**
   * Authenticates connecting WebSocket clients using JWT from handshake.auth.token.
   * Extracts tenantId, userId, and role, attaches them to client.data,
   * and automatically joins client to isolated tenant and agent rooms.
   */
  handleConnection(client: Socket): void {
    const rawToken =
      (client.handshake.auth?.token as string | undefined) ||
      (client.handshake.headers['authorization'] as string | undefined)?.replace(/^Bearer\s+/i, '') ||
      (client.handshake.query?.token as string | undefined);

    if (!rawToken) {
      this.logger.warn(`[WarRoomGateway] Rejected unauthenticated connection: Socket ${client.id}`);
      client.emit('error', { message: 'Authentication required: Missing JWT token in handshake.auth.token' });
      client.disconnect(true);
      return;
    }

    try {
      const decoded = jwt.verify(rawToken, this.jwtSecret) as any;
      const tenantId = decoded.tenantId || decoded.tenant_id;
      const userId = decoded.sub || decoded.userId;
      const role = decoded.role || (decoded.roles && decoded.roles[0]) || 'AGENT';

      if (!tenantId || !userId) {
        throw new Error('JWT token missing tenantId or userId/sub');
      }

      const authData: WarRoomAuthData = {
        tenantId,
        userId,
        role,
        tokenPayload: decoded,
      };
      client.data = authData;

      // Automatically join isolated rooms
      const warRoom = `tenant:${tenantId}:war-room`;
      const agentRoom = `tenant:${tenantId}:agent:${userId}`;

      client.join(warRoom);
      client.join(agentRoom);

      this.logger.log(
        `[WarRoomGateway] Socket ${client.id} authenticated (Tenant: ${tenantId}, User: ${userId}, Role: ${role}). Joined ${warRoom} & ${agentRoom}`,
      );

      client.emit('authenticated', {
        status: 'CONNECTED',
        tenantId,
        userId,
        role,
        rooms: [warRoom, agentRoom],
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      this.logger.warn(
        `[WarRoomGateway] Invalid JWT token for socket ${client.id}: ${err.message}`,
      );
      client.emit('error', {
        message: 'Unauthorized: Invalid or expired JWT token',
        reason: err.message,
      });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`[WarRoomGateway] Socket ${client.id} disconnected`);
  }

  /**
   * Broadcasts an SLA Warning or SLA Breach alert to tenant:{tenantId}:war-room.
   */
  broadcastSlaAlert(tenantId: string, alert: SlaWarRoomAlert): void {
    const room = `tenant:${tenantId}:war-room`;
    const eventName = alert.type === 'BREACH' ? 'sla.breach' : 'sla.warning';

    this.server?.to(room).emit(eventName, {
      event: eventName,
      tenantId,
      ticketId: alert.ticketId,
      ticketNumber: alert.ticketNumber,
      priority: alert.priority,
      status: alert.status,
      breachedAt: alert.breachedAt,
      warningAt: alert.warningAt,
      assignedAgentId: alert.assignedAgentId,
      timestamp: new Date().toISOString(),
    });

    this.logger.debug(
      `[WarRoomGateway] Broadcasted '${eventName}' for ticket ${alert.ticketId} to room ${room}`,
    );
  }

  /**
   * Broadcasts personal push-routed ticket assignment to tenant:{tenantId}:agent:{userId}.
   */
  broadcastAgentAssignment(
    tenantId: string,
    agentId: string,
    assignment: AgentAssignmentPayload,
  ): void {
    const room = `tenant:${tenantId}:agent:${agentId}`;

    this.server?.to(room).emit('ticket.assigned', {
      event: 'ticket.assigned',
      tenantId,
      agentId,
      ticketId: assignment.ticketId,
      ticketNumber: assignment.ticketNumber,
      priority: assignment.priority,
      requiredSkills: assignment.requiredSkills,
      assignedAt: assignment.assignedAt,
    });

    this.logger.debug(
      `[WarRoomGateway] Pushed ticket assignment ${assignment.ticketNumber} to personal room ${room}`,
    );
  }

  /**
   * Pushes counter delta throttled/debounced to at most 1 broadcast per 250ms per tenant.
   * Merges multiple rapid increments during traffic spikes to protect client UI from thrashing.
   */
  queueMetricsDelta(tenantId: string, delta: WarRoomMetricsDelta): void {
    const existing = this.pendingDeltas.get(tenantId) || {};
    this.pendingDeltas.set(tenantId, {
      openCount: (existing.openCount || 0) + (delta.openCount || 0),
      atRiskCount: (existing.atRiskCount || 0) + (delta.atRiskCount || 0),
      breachedCount: (existing.breachedCount || 0) + (delta.breachedCount || 0),
      activeAgents: delta.activeAgents ?? existing.activeAgents,
      totalTickets: (existing.totalTickets || 0) + (delta.totalTickets || 0),
    });

    const now = Date.now();
    const lastBroadcast = this.lastBroadcastTimes.get(tenantId) || 0;
    const elapsed = now - lastBroadcast;

    if (elapsed >= 250 && !this.debounceTimers.has(tenantId)) {
      // Outside 250ms window -> Immediate broadcast
      this.flushMetricsDelta(tenantId);
    } else if (!this.debounceTimers.has(tenantId)) {
      // Within 250ms window -> Schedule broadcast for remaining interval
      const delay = Math.max(10, 250 - elapsed);
      const timer = setTimeout(() => {
        this.debounceTimers.delete(tenantId);
        this.flushMetricsDelta(tenantId);
      }, delay);
      this.debounceTimers.set(tenantId, timer);
    }
  }

  /**
   * Flushes any pending aggregated metrics delta to the tenant war room.
   */
  flushMetricsDelta(tenantId: string): void {
    const delta = this.pendingDeltas.get(tenantId);
    if (!delta) return;

    this.pendingDeltas.delete(tenantId);
    this.lastBroadcastTimes.set(tenantId, Date.now());

    const room = `tenant:${tenantId}:war-room`;
    this.server?.to(room).emit('metrics.updated', {
      event: 'metrics.updated',
      tenantId,
      delta: {
        openCount: delta.openCount,
        atRiskCount: delta.atRiskCount,
        breachedCount: delta.breachedCount,
        activeAgents: delta.activeAgents,
        totalTickets: delta.totalTickets,
      },
      timestamp: new Date().toISOString(),
    });

    this.logger.debug(
      `[WarRoomGateway] Broadcasted debounced metrics delta to room ${room}`,
    );
  }

  /**
   * Flushes all pending timers (useful for teardown).
   */
  flushAllMetrics(): void {
    for (const [tenantId, timer] of this.debounceTimers.entries()) {
      clearTimeout(timer);
      this.flushMetricsDelta(tenantId);
    }
    this.debounceTimers.clear();
  }
}
