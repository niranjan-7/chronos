import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { WarRoomGateway } from './gateways/war-room.gateway';
import { WarRoomEventListener } from './listeners/war-room-event.listener';

@Module({
  imports: [CommonModule],
  providers: [WarRoomGateway, WarRoomEventListener],
  exports: [WarRoomGateway],
})
export class WarRoomModule {}
