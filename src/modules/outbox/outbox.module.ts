import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SLA_MONITOR_QUEUE } from '../sla/constants/sla.constants';
import { SlaModule } from '../sla/sla.module';
import { TenantsModule } from '../tenants/tenants.module';
import { OutboxRelayService } from './services/outbox-relay.service';
import { CommonModule } from '../../common/common.module';

@Module({
  imports: [
    CommonModule,
    BullModule.registerQueue({
      name: SLA_MONITOR_QUEUE,
    }),
    SlaModule,
    TenantsModule,
  ],
  providers: [OutboxRelayService],
  exports: [OutboxRelayService],
})
export class OutboxModule {}
