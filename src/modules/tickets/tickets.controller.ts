import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { TicketsService } from './tickets.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { ClaimNextTicketDto, ClaimSpecificTicketDto } from './dto/claim-ticket.dto';
import { TransitionTicketDto } from './dto/transition-ticket.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RoutingMode, TicketPriority, TicketStatus } from '@prisma/client';

@Controller('tickets')
export class TicketsController {
  constructor(private readonly ticketsService: TicketsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createTicket(@Body() dto: CreateTicketDto) {
    return this.ticketsService.createTicket(dto);
  }

  /**
   * Concurrency & Chaos Simulator: Dispatches N rapid tickets across random priorities and skills.
   */
  @Post('simulate/burst')
  @HttpCode(HttpStatus.CREATED)
  async simulateBurst(@Body('count') count?: number) {
    const burstCount = Math.min(50, Math.max(1, count ?? 20));
    const priorities: TicketPriority[] = [
      TicketPriority.URGENT,
      TicketPriority.HIGH,
      TicketPriority.MEDIUM,
      TicketPriority.LOW,
    ];
    const skillSets = [
      ['voice_webrtc'],
      ['messaging_a2p'],
      ['billing'],
      ['rest_api'],
      ['voice_webrtc', 'messaging_a2p'],
      [],
    ];

    const results = [];
    for (let i = 0; i < burstCount; i++) {
      const priority = priorities[Math.floor(Math.random() * priorities.length)];
      const skills = skillSets[Math.floor(Math.random() * skillSets.length)];
      const ticket = await this.ticketsService.createTicket({
        title: `Burst Incident #${i + 1} - ${priority} [${skills.join(',') || 'general'}]`,
        description: `Automated chaos & high-load burst injection test event #${i + 1}`,
        priority,
        routingMode: RoutingMode.AUTO_PUSH,
        requiredSkills: skills,
      });
      results.push(ticket);
    }
    return {
      success: true,
      count: results.length,
      tickets: results,
    };
  }

  /**
   * Atomic, non-blocking claim of the next available OPEN ticket.
   * Utilizes PostgreSQL SELECT ... FOR UPDATE SKIP LOCKED.
   */
  @Post('claim-next')
  @HttpCode(HttpStatus.OK)
  async claimNextTicket(
    @Body() dto: ClaimNextTicketDto,
    @CurrentUser('userId') currentUserId?: string,
  ) {
    return this.ticketsService.claimNextTicket(dto, currentUserId);
  }

  /**
   * Atomic claim of a specific ticket by UUID.
   */
  @Post(':id/claim')
  @HttpCode(HttpStatus.OK)
  async claimSpecificTicket(
    @Param('id') id: string,
    @Body() dto: ClaimSpecificTicketDto,
    @CurrentUser('userId') currentUserId?: string,
  ) {
    return this.ticketsService.claimSpecificTicket(id, dto, currentUserId);
  }

  /**
   * State Machine transition endpoint.
   * Enforces valid transitions and transactional audit logging.
   */
  @Post(':id/transition')
  @HttpCode(HttpStatus.OK)
  async transitionTicket(
    @Param('id') id: string,
    @Body() dto: TransitionTicketDto,
    @CurrentUser('userId') currentUserId?: string,
  ) {
    return this.ticketsService.transitionTicket(id, dto, currentUserId);
  }

  @Get()
  async getTickets(
    @Query('status') status?: TicketStatus,
    @Query('priority') priority?: TicketPriority,
    @Query('assignedAgentId') assignedAgentId?: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
  ) {
    return this.ticketsService.getTickets({
      status,
      priority,
      assignedAgentId,
      skip: skip ? parseInt(skip, 10) : undefined,
      take: take ? parseInt(take, 10) : undefined,
    });
  }

  @Get(':id')
  async getTicketById(@Param('id') id: string) {
    return this.ticketsService.getTicketById(id);
  }

  @Patch(':id')
  async updateTicket(
    @Param('id') id: string,
    @Body() dto: UpdateTicketDto,
  ) {
    return this.ticketsService.updateTicket(id, dto);
  }

  @Get(':id/audit-logs')
  async getAuditLogs(@Param('id') id: string) {
    return this.ticketsService.getAuditLogs(id);
  }
}
