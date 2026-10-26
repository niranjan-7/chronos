import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { WebhookDispatcherService } from './services/webhook-dispatcher.service';
import { CircuitBreakerService } from './services/circuit-breaker.service';
import { CreateWebhookEndpointDto } from './dto/create-webhook-endpoint.dto';
import { UpdateWebhookEndpointDto } from './dto/update-webhook-endpoint.dto';

@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly dispatcherService: WebhookDispatcherService,
    private readonly circuitBreakerService: CircuitBreakerService,
  ) {}

  @Post('endpoints')
  @HttpCode(HttpStatus.CREATED)
  async createEndpoint(
    @CurrentTenant() tenantId: string,
    @Body() dto: CreateWebhookEndpointDto,
  ) {
    return this.dispatcherService.createEndpoint(tenantId, dto);
  }

  @Get('endpoints')
  async listEndpoints(@CurrentTenant() tenantId: string) {
    return this.dispatcherService.listEndpoints(tenantId);
  }

  @Get('endpoints/:id')
  async getEndpoint(
    @CurrentTenant() tenantId: string,
    @Param('id') endpointId: string,
  ) {
    return this.dispatcherService.getEndpoint(tenantId, endpointId);
  }

  @Patch('endpoints/:id')
  async updateEndpoint(
    @CurrentTenant() tenantId: string,
    @Param('id') endpointId: string,
    @Body() dto: UpdateWebhookEndpointDto,
  ) {
    return this.dispatcherService.updateEndpoint(tenantId, endpointId, dto);
  }

  @Delete('endpoints/:id')
  async deleteEndpoint(
    @CurrentTenant() tenantId: string,
    @Param('id') endpointId: string,
  ) {
    return this.dispatcherService.deleteEndpoint(tenantId, endpointId);
  }

  @Get('dlq')
  async getDeadLetterQueue(
    @CurrentTenant() tenantId: string,
    @Query('limit') limit?: string,
  ) {
    const take = limit ? parseInt(limit, 10) : 50;
    return this.dispatcherService.getDeadLetterQueue(tenantId, take);
  }

  /**
   * Replays a single failed delivery from the Dead Letter Queue.
   */
  @Post('dlq/:deliveryId/replay')
  @HttpCode(HttpStatus.OK)
  async replayDeadLetterDelivery(
    @CurrentTenant() tenantId: string,
    @Param('deliveryId') deliveryId: string,
  ) {
    return this.dispatcherService.replayDeadLetterDelivery(tenantId, deliveryId);
  }

  /**
   * Replays all Dead Letter Queue deliveries for a specific endpoint.
   */
  @Post('endpoints/:id/replay-all')
  @HttpCode(HttpStatus.OK)
  async replayAllEndpointFailures(
    @CurrentTenant() tenantId: string,
    @Param('id') endpointId: string,
  ) {
    return this.dispatcherService.replayAllEndpointFailures(tenantId, endpointId);
  }

  /**
   * Manually resets circuit breaker state for an endpoint to CLOSED.
   */
  @Post('endpoints/:id/circuit/reset')
  @HttpCode(HttpStatus.OK)
  async resetCircuit(
    @CurrentTenant() tenantId: string,
    @Param('id') endpointId: string,
  ) {
    await this.circuitBreakerService.resetCircuit(tenantId, endpointId);
    return { success: true, message: `Circuit breaker reset to CLOSED for endpoint ${endpointId}` };
  }
}
