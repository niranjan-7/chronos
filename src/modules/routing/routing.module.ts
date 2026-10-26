import { Module } from '@nestjs/common';
import { RoutingService } from './routing.service';
import { RoutingController } from './routing.controller';
import { TicketsModule } from '../tickets/tickets.module';
import { RoutingRedisService } from './services/routing-redis.service';
import { RoutingEventListener } from './listeners/routing-event.listener';

@Module({
  imports: [TicketsModule],
  controllers: [RoutingController],
  providers: [RoutingService, RoutingRedisService, RoutingEventListener],
  exports: [RoutingService, RoutingRedisService],
})
export class RoutingModule {}
