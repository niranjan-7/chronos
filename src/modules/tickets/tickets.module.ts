import { Module } from '@nestjs/common';
import { TicketsService } from './tickets.service';
import { TicketsController } from './tickets.controller';
import { TicketsRepository } from './repositories/tickets.repository';
import { TicketStateMachine } from './state-machine/ticket-state-machine';

@Module({
  controllers: [TicketsController],
  providers: [TicketsService, TicketsRepository, TicketStateMachine],
  exports: [TicketsService, TicketsRepository, TicketStateMachine],
})
export class TicketsModule {}
