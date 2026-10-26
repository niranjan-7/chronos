import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsMetricsService } from './services/analytics-metrics.service';
import { EventsGateway } from './gateways/events.gateway';
import { WebhookDispatcherService } from './services/webhook-dispatcher.service';
import { WebhookProcessor } from './processors/webhook.processor';
import { AnalyticsEventListener } from './listeners/analytics-event.listener';
import { WEBHOOK_DISPATCHER_QUEUE } from './constants/webhook.constants';

@Module({
  imports: [
    BullModule.registerQueue({
      name: WEBHOOK_DISPATCHER_QUEUE,
    }),
  ],
  controllers: [AnalyticsController],
  providers: [
    AnalyticsService,
    AnalyticsMetricsService,
    EventsGateway,
    WebhookDispatcherService,
    WebhookProcessor,
    AnalyticsEventListener,
  ],
  exports: [
    AnalyticsService,
    AnalyticsMetricsService,
    EventsGateway,
    WebhookDispatcherService,
  ],
})
export class AnalyticsModule {}
