import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { SlaService } from './sla.service';
import { CreateSlaPolicyDto } from './dto/create-sla-policy.dto';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { SlaCalendarCalculatorService } from './services/sla-calendar-calculator.service';
import { TenantCalendarService } from '../tenants/services/tenant-calendar.service';
import { TicketPriority } from '@prisma/client';

@Controller('sla/policies')
export class SlaController {
  constructor(
    private readonly slaService: SlaService,
    private readonly calculatorService: SlaCalendarCalculatorService,
    private readonly tenantCalendarService: TenantCalendarService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createPolicy(@Body() dto: CreateSlaPolicyDto) {
    return this.slaService.createPolicy(dto);
  }

  @Get()
  async listPolicies() {
    return this.slaService.listPolicies();
  }

  /**
   * Interactive SLA Deadline Calculator Preview.
   * Calculates Warning (80%) and Breach (100%) UTC & Local timestamps based on
   * tenant business schedule, active operating hours, and holiday calendar.
   */
  @Post('calculate-deadline')
  @HttpCode(HttpStatus.OK)
  async calculateDeadline(
    @CurrentTenant() tenantId: string,
    @Body()
    dto: {
      priority: TicketPriority | 'P1' | 'P2' | 'P3' | 'P4';
      startTimestamp?: string;
      timezone?: string;
    },
  ) {
    const priorityMap: Record<string, { priority: TicketPriority; ms: number }> = {
      P1: { priority: TicketPriority.URGENT, ms: 60 * 60 * 1000 },
      URGENT: { priority: TicketPriority.URGENT, ms: 60 * 60 * 1000 },
      P2: { priority: TicketPriority.HIGH, ms: 4 * 60 * 60 * 1000 },
      HIGH: { priority: TicketPriority.HIGH, ms: 4 * 60 * 60 * 1000 },
      P3: { priority: TicketPriority.MEDIUM, ms: 8 * 60 * 60 * 1000 },
      MEDIUM: { priority: TicketPriority.MEDIUM, ms: 8 * 60 * 60 * 1000 },
      P4: { priority: TicketPriority.LOW, ms: 24 * 60 * 60 * 1000 },
      LOW: { priority: TicketPriority.LOW, ms: 24 * 60 * 60 * 1000 },
    };

    const target = priorityMap[dto.priority] || priorityMap.P2;
    const { calendar, holidays } =
      await this.tenantCalendarService.getTenantCalendarContext(tenantId);

    const effectiveCalendar = dto.timezone
      ? { ...calendar, timezone: dto.timezone }
      : calendar;
    const start = dto.startTimestamp ? new Date(dto.startTimestamp) : new Date();

    const deadlines = this.calculatorService.calculateDeadlines(
      start,
      target.ms,
      effectiveCalendar,
      holidays,
    );

    return {
      priority: target.priority,
      slaTargetMs: target.ms,
      startTimestamp: start.toISOString(),
      timezone: effectiveCalendar.timezone,
      ...deadlines,
    };
  }

  @Get(':id')
  async getPolicyById(@Param('id') id: string) {
    return this.slaService.getPolicyById(id);
  }

  @Patch(':id')
  async updatePolicy(
    @Param('id') id: string,
    @Body() dto: Partial<CreateSlaPolicyDto>,
  ) {
    return this.slaService.updatePolicy(id, dto);
  }
}
