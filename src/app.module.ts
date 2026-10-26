import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClsModule } from 'nestjs-cls';
import { BullModule } from '@nestjs/bullmq';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { v4 as uuidv4 } from 'uuid';
import { CommonModule } from './common/common.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { TicketsModule } from './modules/tickets/tickets.module';
import { SlaModule } from './modules/sla/sla.module';
import { RoutingModule } from './modules/routing/routing.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { OutboxModule } from './modules/outbox/outbox.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { AppController } from './app.controller';
import { REQUEST_ID_HEADER } from './common/constants/context.constants';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.example'],
    }),
    EventEmitterModule.forRoot({
      wildcard: false,
      delimiter: '.',
      newListener: false,
      removeListener: false,
      maxListeners: 20,
      verboseMemoryLeak: true,
      ignoreErrors: false,
    }),
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (req) => {
          const headerId = req.headers[REQUEST_ID_HEADER];
          return (Array.isArray(headerId) ? headerId[0] : headerId) || uuidv4();
        },
      },
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get<string>('REDIS_PASSWORD', 'redis_secret'),
          maxRetriesPerRequest: null,
        },
      }),
      inject: [ConfigService],
    }),
    CommonModule,
    ScheduleModule.forRoot(),
    TenantsModule,
    TicketsModule,
    SlaModule,
    RoutingModule,
    AnalyticsModule,
    OutboxModule,
    WebhooksModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
