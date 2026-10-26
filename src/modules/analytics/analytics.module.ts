import { Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsMetricsService } from './services/analytics-metrics.service';
import { EventsGateway } from './gateways/events.gateway';
import { AnalyticsEventListener } from './listeners/analytics-event.listener';
import { WebhooksModule } from '../webhooks/webhooks.module';

@Module({
  imports: [WebhooksModule],
  controllers: [AnalyticsController],
  providers: [
    AnalyticsService,
    AnalyticsMetricsService,
    EventsGateway,
    AnalyticsEventListener,
  ],
  exports: [
    AnalyticsService,
    AnalyticsMetricsService,
    EventsGateway,
    WebhooksModule,
  ],
})
export class AnalyticsModule {}
