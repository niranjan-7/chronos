import {
  Logger,
} from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@WebSocketGateway({
  namespace: '/events',
  cors: {
    origin: '*',
  },
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(EventsGateway.name);

  @WebSocketServer()
  server!: Server;

  /**
   * Authenticates connecting WebSocket clients via tenantId header, auth payload, or query.
   * Auto-joins the socket to its tenant-scoped channel ('tenant:{tenantId}').
   */
  handleConnection(client: Socket): void {
    const rawTenantId =
      client.handshake.headers['x-tenant-id'] ||
      (client.handshake.auth?.tenantId as string | undefined) ||
      (client.handshake.query?.tenantId as string | undefined);

    const tenantId = Array.isArray(rawTenantId) ? rawTenantId[0] : rawTenantId;

    if (!tenantId || !UUID_V4_REGEX.test(tenantId)) {
      this.logger.warn(`Unauthorized WebSocket connection rejected: Socket ${client.id}`);
      client.emit('error', { message: 'Missing or invalid x-tenant-id for WebSocket connection' });
      client.disconnect(true);
      return;
    }

    client.data.tenantId = tenantId;
    const room = `tenant:${tenantId}`;
    client.join(room);

    this.logger.log(`WebSocket client ${client.id} joined channel ${room}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`WebSocket client ${client.id} disconnected`);
  }

  /**
   * Broadcasts an event strictly to sockets belonging to the target tenant.
   */
  broadcastToTenant(tenantId: string, event: string, payload: unknown): void {
    if (!this.server) return;
    const room = `tenant:${tenantId}`;
    this.server.to(room).emit(event, {
      event,
      timestamp: new Date().toISOString(),
      payload,
    });
    this.logger.debug(`Broadcasted '${event}' to room ${room}`);
  }

  broadcastTicketClaimed(tenantId: string, payload: unknown): void {
    this.broadcastToTenant(tenantId, 'ticket.claimed', payload);
  }

  broadcastSlaWarning(tenantId: string, payload: unknown): void {
    this.broadcastToTenant(tenantId, 'sla.warning', payload);
  }

  broadcastSlaBreached(tenantId: string, payload: unknown): void {
    this.broadcastToTenant(tenantId, 'sla.breached', payload);
  }
}
