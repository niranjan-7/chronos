import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { AnalyticsMetricsService } from './services/analytics-metrics.service';
import { WebhookDispatcherService } from './services/webhook-dispatcher.service';
import { CreateWebhookSubscriptionDto } from './dto/create-webhook-subscription.dto';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';

@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly metricsService: AnalyticsMetricsService,
    private readonly webhookService: WebhookDispatcherService,
  ) {}

  /**
   * Pre-aggregated CQRS live metrics dashboard.
   * Reads directly from tenant-namespaced Redis Hashes for sub-50ms latency.
   * Automatically executes cache-rebuild fallback on cache miss.
   */
  @Get('dashboard')
  async getDashboard(@CurrentTenant() tenantId: string) {
    const cached = await this.metricsService.getLiveMetrics(tenantId);
    if (cached) {
      return cached;
    }
    return this.metricsService.rebuildLiveMetrics(tenantId);
  }

  @Get('overview')
  async getOverview() {
    return this.analyticsService.getTenantOverview();
  }

  // --- Outbound Webhooks & DLQ Endpoints ---

  @Post('webhooks/subscriptions')
  @HttpCode(HttpStatus.CREATED)
  async createWebhookSubscription(
    @CurrentTenant() tenantId: string,
    @Body() dto: CreateWebhookSubscriptionDto,
  ) {
    return this.webhookService.createSubscription(tenantId, dto);
  }

  @Get('webhooks/subscriptions')
  async listWebhookSubscriptions(@CurrentTenant() tenantId: string) {
    return this.webhookService.listSubscriptions(tenantId);
  }

  @Get('webhooks/dlq')
  async getDeadLetterQueue(
    @CurrentTenant() tenantId: string,
    @Query('limit') limit?: string,
  ) {
    const take = limit ? parseInt(limit, 10) : 50;
    return this.webhookService.getDeadLetterQueue(tenantId, take);
  }

  @Post('webhooks/dlq/:deliveryId/retry')
  @HttpCode(HttpStatus.OK)
  async retryDeadLetterDelivery(
    @CurrentTenant() tenantId: string,
    @Param('deliveryId') deliveryId: string,
  ) {
    return this.webhookService.retryDeadLetterJob(deliveryId, tenantId);
  }
}
