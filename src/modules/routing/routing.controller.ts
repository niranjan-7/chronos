import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { RoutingService } from './routing.service';
import { RouteTicketDto } from './dto/route-ticket.dto';

@Controller('routing')
export class RoutingController {
  constructor(private readonly routingService: RoutingService) {}

  @Post('match')
  @HttpCode(HttpStatus.OK)
  async routeTicket(@Body() dto: RouteTicketDto) {
    return this.routingService.matchAndRouteTicket(dto);
  }
}
