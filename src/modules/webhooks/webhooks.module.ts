import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WEBHOOK_DISPATCHER_QUEUE } from './constants/webhook.constants';
import { WebhooksController } from './webhooks.controller';
import { WebhookCryptoService } from './services/webhook-crypto.service';
import { CircuitBreakerService } from './services/circuit-breaker.service';
import { WebhookDispatcherService } from './services/webhook-dispatcher.service';
import { WebhookProcessor } from './processors/webhook.processor';

@Module({
  imports: [
    BullModule.registerQueue({
      name: WEBHOOK_DISPATCHER_QUEUE,
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
  ],
  controllers: [WebhooksController],
  providers: [
    WebhookCryptoService,
    CircuitBreakerService,
    WebhookDispatcherService,
    WebhookProcessor,
  ],
  exports: [
    WebhookCryptoService,
    CircuitBreakerService,
    WebhookDispatcherService,
  ],
})
export class WebhooksModule {}
