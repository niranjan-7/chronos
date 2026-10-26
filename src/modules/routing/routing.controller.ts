import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AppClsStore } from '../../common/context/app-cls.store';
import { CLS_TENANT_ID } from '../../common/constants/context.constants';
import { RoutingService } from './routing.service';
import { RouteTicketDto } from './dto/route-ticket.dto';
import { RegisterAgentSkillsDto } from './dto/register-agent-skills.dto';
import { UpdateAgentStatusDto } from './dto/update-agent-status.dto';
import { AutoRouteTicketDto } from './dto/auto-route-ticket.dto';

@Controller('routing')
export class RoutingController {
  constructor(
    private readonly routingService: RoutingService,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  private getTenantId(): string {
    const tenantId = this.cls.get(CLS_TENANT_ID);
    if (!tenantId) {
      throw new UnauthorizedException('Active tenant context required.');
    }
    return tenantId;
  }

  @Post('agents/:id/skills')
  @HttpCode(HttpStatus.OK)
  async registerAgentSkills(
    @Param('id') agentId: string,
    @Body() dto: RegisterAgentSkillsDto,
  ) {
    const tenantId = this.getTenantId();
    await this.routingService.registerAgentSkills(
      tenantId,
      agentId,
      dto.skills,
      dto.maxCapacity,
    );
    return { success: true, message: 'Agent skills updated and synced to Redis.' };
  }

  @Patch('agents/:id/status')
  @HttpCode(HttpStatus.OK)
  async updateAgentStatus(
    @Param('id') agentId: string,
    @Body() dto: UpdateAgentStatusDto,
  ) {
    const tenantId = this.getTenantId();
    await this.routingService.updateAgentStatus(tenantId, agentId, dto.status);
    return { success: true, message: `Agent status updated to ${dto.status}.` };
  }

  @Post('auto-route')
  @HttpCode(HttpStatus.OK)
  async autoRouteTicket(@Body() dto: AutoRouteTicketDto) {
    const tenantId = this.getTenantId();
    return this.routingService.autoRouteTicket(tenantId, dto.ticketId, dto.requiredSkills);
  }

  @Post('match')
  @HttpCode(HttpStatus.OK)
  async routeTicket(@Body() dto: RouteTicketDto) {
    return this.routingService.matchAndRouteTicket(dto);
  }
}
