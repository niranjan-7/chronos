import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule, EventEmitter2 } from '@nestjs/event-emitter';
import { ClsModule } from 'nestjs-cls';
import { io, Socket as ClientSocket } from 'socket.io-client';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../src/common/database/prisma.service';
import { RedisIoAdapter } from '../src/modules/war-room/adapters/redis-io.adapter';
import { WarRoomGateway } from '../src/modules/war-room/gateways/war-room.gateway';
import { WarRoomEventListener } from '../src/modules/war-room/listeners/war-room-event.listener';
import { CommonModule } from '../src/common/common.module';
import { TicketPriority, TicketStatus } from '@prisma/client';
import {
  SlaBreachedEvent,
  SlaWarningEvent,
  TicketTransitionedEvent,
} from '../src/common/events/ticket.events';
import {
  SLA_BREACHED_EVENT,
  SLA_WARNING_EVENT,
  TICKET_TRANSITIONED_EVENT,
} from '../src/common/events/domain-event.constants';

describe('Real-Time War-Room Gateway & Redis Pub/Sub Adapter (Integration)', () => {
  let app: INestApplication;
  let redisIoAdapter: RedisIoAdapter;
  let prisma: PrismaService;
  let eventEmitter: EventEmitter2;
  let warRoomGateway: WarRoomGateway;
  let configService: ConfigService;

  let serverPort: number;
  let jwtSecret: string;

  let tenant1Id: string;
  let tenant2Id: string;
  let ticket1Id: string;

  let agent1Id: string;
  let agent2Id: string;

  const activeSockets: ClientSocket[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath: ['.env', '.env.example'],
        }),
        ClsModule.forRoot({
          global: true,
        }),
        EventEmitterModule.forRoot({
          wildcard: false,
        }),
        CommonModule,
      ],
      providers: [WarRoomGateway, WarRoomEventListener],
    }).compile();

    app = moduleFixture.createNestApplication();
    configService = app.get(ConfigService);
    jwtSecret =
      configService.get<string>('JWT_SECRET') ||
      'chronos-super-secret-jwt-key-32-chars-min!';

    eventEmitter = app.get(EventEmitter2);
    warRoomGateway = app.get(WarRoomGateway);

    redisIoAdapter = new RedisIoAdapter(app);
    await redisIoAdapter.connectToRedis(configService);
    app.useWebSocketAdapter(redisIoAdapter as any);

    await app.init();
    await app.listen(0);

    const address = app.getHttpServer().address();
    serverPort = typeof address === 'string' ? 0 : address.port;

    // Seed test tenants & ticket
    const t1 = await prisma.tenant.create({
      data: {
        name: 'War-Room Tenant Alpha',
        slug: `war-room-alpha-${Date.now()}`,
      },
    });
    tenant1Id = t1.id;

    const user1 = await prisma.user.create({
      data: {
        tenantId: tenant1Id,
        email: `agent1-${Date.now()}@test.local`,
        name: 'Agent 1',
        role: 'AGENT',
      },
    });
    agent1Id = user1.id;

    const user2 = await prisma.user.create({
      data: {
        tenantId: tenant1Id,
        email: `agent2-${Date.now()}@test.local`,
        name: 'Agent 2',
        role: 'AGENT',
      },
    });
    agent2Id = user2.id;

    const t2 = await prisma.tenant.create({
      data: {
        name: 'War-Room Tenant Beta',
        slug: `war-room-beta-${Date.now()}`,
      },
    });
    tenant2Id = t2.id;

    const ticket = await prisma.ticket.create({
      data: {
        tenantId: tenant1Id,
        ticketNumber: `WR-${Date.now()}`,
        title: 'Critical Outage Ticket',
        description: 'Critical outage impacting customer WebRTC voice streams',
        priority: TicketPriority.URGENT,
        status: TicketStatus.IN_PROGRESS,
        assignedAgentId: agent1Id,
        requiredSkills: ['voice_webrtc', 'messaging_a2p'],
      },
    });
    ticket1Id = ticket.id;
  }, 30000);

  afterAll(async () => {
    if (warRoomGateway) {
      warRoomGateway.flushAllMetrics();
    }

    for (const socket of activeSockets) {
      if (socket.connected) {
        socket.disconnect();
      }
    }

    if (ticket1Id) {
      await prisma.ticket.deleteMany({ where: { id: ticket1Id } });
    }
    if (tenant1Id) {
      await prisma.tenant.deleteMany({ where: { id: tenant1Id } });
    }
    if (tenant2Id) {
      await prisma.tenant.deleteMany({ where: { id: tenant2Id } });
    }

    if (redisIoAdapter) {
      await redisIoAdapter.close();
    }
    if (app) {
      await app.close();
    }
    if (prisma) {
      await prisma.$disconnect();
    }
  });

  const createClient = (token?: string): Promise<ClientSocket> => {
    return new Promise((resolve) => {
      const client = io(`http://127.0.0.1:${serverPort}/war-room`, {
        transports: ['websocket'],
        auth: token ? { token } : {},
        forceNew: true,
        reconnection: false,
      });

      activeSockets.push(client);
      resolve(client);
    });
  };

  describe('Handshake Authentication & Room Isolation', () => {
    it('should successfully authenticate client with valid JWT and receive connection ack', (done) => {
      const token = jwt.sign(
        { tenantId: tenant1Id, sub: agent1Id, role: 'AGENT' },
        jwtSecret,
        { expiresIn: '1h' },
      );

      createClient(token).then((socket) => {
        socket.on('authenticated', (ack) => {
          expect(ack.status).toBe('CONNECTED');
          expect(ack.tenantId).toBe(tenant1Id);
          expect(ack.userId).toBe(agent1Id);
          expect(ack.rooms).toContain(`tenant:${tenant1Id}:war-room`);
          expect(ack.rooms).toContain(`tenant:${tenant1Id}:agent:${agent1Id}`);
          done();
        });

        socket.on('error', (err) => {
          done(new Error(`Unexpected error: ${JSON.stringify(err)}`));
        });
      });
    });

    it('should reject and disconnect client connecting without JWT', (done) => {
      createClient().then((socket) => {
        socket.on('error', (err) => {
          expect(err.message).toContain('Authentication required');
        });

        socket.on('disconnect', () => {
          done();
        });
      });
    });

    it('should enforce strict cross-tenant isolation: Tenant 1 events never leak to Tenant 2', (done) => {
      const tokenTenant1 = jwt.sign(
        { tenantId: tenant1Id, sub: agent1Id, role: 'AGENT' },
        jwtSecret,
      );
      const tokenTenant2 = jwt.sign(
        { tenantId: tenant2Id, sub: agent2Id, role: 'AGENT' },
        jwtSecret,
      );

      let tenant2ReceivedEvent = false;

      Promise.all([createClient(tokenTenant1), createClient(tokenTenant2)]).then(
        ([socketT1, socketT2]) => {
          socketT2.on('sla.warning', () => {
            tenant2ReceivedEvent = true;
          });

          socketT1.on('sla.warning', (data) => {
            expect(data.tenantId).toBe(tenant1Id);
            expect(data.ticketId).toBe(ticket1Id);

            // Wait 200ms to ensure Tenant 2 never received anything
            setTimeout(() => {
              expect(tenant2ReceivedEvent).toBe(false);
              done();
            }, 200);
          });

          // Wait until both clients are ready, then broadcast SLA warning to Tenant 1
          setTimeout(() => {
            warRoomGateway.broadcastSlaAlert(tenant1Id, {
              ticketId: ticket1Id,
              ticketNumber: 'WR-1001',
              priority: 'URGENT',
              status: 'IN_PROGRESS',
              type: 'WARNING',
              warningAt: new Date().toISOString(),
            });
          }, 150);
        },
      );
    });
  });

  describe('Event-Driven Broadcasts', () => {
    it('should broadcast SLA warning when domain event is emitted', (done) => {
      const token = jwt.sign(
        { tenantId: tenant1Id, sub: agent1Id, role: 'AGENT' },
        jwtSecret,
      );

      createClient(token).then((socket) => {
        socket.on('sla.warning', (payload) => {
          expect(payload.event).toBe('sla.warning');
          expect(payload.tenantId).toBe(tenant1Id);
          expect(payload.ticketId).toBe(ticket1Id);
          expect(payload.priority).toBe(TicketPriority.URGENT);
          done();
        });

        setTimeout(() => {
          eventEmitter.emit(
            SLA_WARNING_EVENT,
            new SlaWarningEvent(
              tenant1Id,
              ticket1Id,
              'WR-1001',
              new Date(Date.now() + 3600000).toISOString(),
              new Date(),
            ),
          );
        }, 150);
      });
    });

    it('should broadcast SLA breach when domain event is emitted', (done) => {
      const token = jwt.sign(
        { tenantId: tenant1Id, sub: agent1Id, role: 'AGENT' },
        jwtSecret,
      );

      createClient(token).then((socket) => {
        socket.on('sla.breach', (payload) => {
          expect(payload.event).toBe('sla.breach');
          expect(payload.tenantId).toBe(tenant1Id);
          expect(payload.ticketId).toBe(ticket1Id);
          expect(payload.priority).toBe(TicketPriority.URGENT);
          done();
        });

        setTimeout(() => {
          eventEmitter.emit(
            SLA_BREACHED_EVENT,
            new SlaBreachedEvent(
              tenant1Id,
              ticket1Id,
              'WR-1001',
              TicketPriority.HIGH,
              TicketPriority.URGENT,
              new Date(),
            ),
          );
        }, 150);
      });
    });

    it('should deliver push-routed ticket assignment only to target agent room', (done) => {
      const tokenAgent1 = jwt.sign(
        { tenantId: tenant1Id, sub: agent1Id, role: 'AGENT' },
        jwtSecret,
      );
      const tokenAgent2 = jwt.sign(
        { tenantId: tenant1Id, sub: agent2Id, role: 'AGENT' },
        jwtSecret,
      );

      let agent2ReceivedAssignment = false;

      Promise.all([createClient(tokenAgent1), createClient(tokenAgent2)]).then(
        ([socketAgent1, socketAgent2]) => {
          socketAgent2.on('ticket.assigned', () => {
            agent2ReceivedAssignment = true;
          });

          socketAgent1.on('ticket.assigned', (payload) => {
            expect(payload.event).toBe('ticket.assigned');
            expect(payload.agentId).toBe(agent1Id);
            expect(payload.ticketId).toBe(ticket1Id);

            setTimeout(() => {
              expect(agent2ReceivedAssignment).toBe(false);
              done();
            }, 200);
          });

          setTimeout(() => {
            eventEmitter.emit(
              TICKET_TRANSITIONED_EVENT,
              new TicketTransitionedEvent(
                tenant1Id,
                ticket1Id,
                TicketStatus.OPEN,
                TicketStatus.ASSIGNED,
                agent1Id,
                'Push routed to best skill match',
              ),
            );
          }, 150);
        },
      );
    });

    it('should debounce rapid metrics mutations to protect client from UI thrashing (250ms window)', (done) => {
      const token = jwt.sign(
        { tenantId: tenant1Id, sub: agent1Id, role: 'AGENT' },
        jwtSecret,
      );

      createClient(token).then((socket) => {
        let broadcastCount = 0;
        let lastReceivedDelta: any = null;

        socket.on('metrics.updated', (payload) => {
          broadcastCount++;
          lastReceivedDelta = payload.delta;
        });

        // Ensure socket is connected and clean initial state
        setTimeout(() => {
          // Fire initial event to establish baseline
          eventEmitter.emit('metrics.mutated', {
            tenantId: tenant1Id,
            increments: { open_count: 1 },
          });

          // Within next 100ms, fire 4 rapid increments
          setTimeout(() => {
            eventEmitter.emit('metrics.mutated', {
              tenantId: tenant1Id,
              increments: { open_count: 2, at_risk_count: 1 },
            });
            eventEmitter.emit('metrics.mutated', {
              tenantId: tenant1Id,
              increments: { open_count: 3, breached_count: 2 },
            });
            eventEmitter.emit('metrics.mutated', {
              tenantId: tenant1Id,
              increments: { open_count: -1 },
            });
          }, 30);

          // After debounce window (350ms), exactly 2 broadcasts should have been received total:
          // Broadcast 1: initial open_count 1
          // Broadcast 2: merged delta: openCount (2 + 3 - 1 = 4), atRiskCount (1), breachedCount (2)
          setTimeout(() => {
            expect(broadcastCount).toBe(2);
            expect(lastReceivedDelta.openCount).toBe(4);
            expect(lastReceivedDelta.atRiskCount).toBe(1);
            expect(lastReceivedDelta.breachedCount).toBe(2);
            done();
          }, 450);
        }, 150);
      });
    });
  });
});
