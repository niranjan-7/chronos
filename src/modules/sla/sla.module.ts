import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SlaService } from './sla.service';
import { SlaController } from './sla.controller';
import { SlaRepository } from './repositories/sla.repository';
import { SlaPolicyService } from './services/sla-policy.service';
import { SlaQueueService } from './services/sla-queue.service';
import { SlaEventListener } from './listeners/sla-event.listener';
import { SlaProcessor } from './processors/sla.processor';
import { SLA_MONITOR_QUEUE } from './constants/sla.constants';

@Module({
  imports: [
    BullModule.registerQueue({
      name: SLA_MONITOR_QUEUE,
    }),
  ],
  controllers: [SlaController],
  providers: [
    SlaService,
    SlaRepository,
    SlaPolicyService,
    SlaQueueService,
    SlaEventListener,
    SlaProcessor,
  ],
  exports: [
    SlaService,
    SlaRepository,
    SlaPolicyService,
    SlaQueueService,
  ],
})
export class SlaModule {}
