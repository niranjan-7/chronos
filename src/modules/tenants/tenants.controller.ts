import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { SkipTenantCheck } from '../../common/decorators/public.decorator';
import {
  CreateHolidayDto,
  TenantCalendarService,
  UpdateCalendarDto,
} from './services/tenant-calendar.service';

@Controller('tenants')
export class TenantsController {
  constructor(
    private readonly tenantsService: TenantsService,
    private readonly calendarService: TenantCalendarService,
  ) {}

  @Post()
  @SkipTenantCheck()
  @HttpCode(HttpStatus.CREATED)
  async createTenant(@Body() dto: CreateTenantDto) {
    return this.tenantsService.createTenant(dto);
  }

  @Get()
  @SkipTenantCheck()
  async listTenants() {
    return this.tenantsService.listTenants();
  }

  @Get('me')
  async getCurrentTenant(@CurrentTenant() tenantId: string) {
    return this.tenantsService.getTenantById(tenantId);
  }

  @Get(':id')
  @SkipTenantCheck()
  async getTenantById(@Param('id') id: string) {
    return this.tenantsService.getTenantById(id);
  }

  @Patch(':id')
  @SkipTenantCheck()
  async updateTenant(@Param('id') id: string, @Body() dto: UpdateTenantDto) {
    return this.tenantsService.updateTenant(id, dto);
  }

  // --- Phase 5: Business Calendar & Holiday Endpoints ---

  @Get(':id/calendar')
  @SkipTenantCheck()
  async getCalendar(@Param('id') id: string) {
    return this.calendarService.getTenantCalendarContext(id);
  }

  @Put(':id/calendar')
  @SkipTenantCheck()
  async updateCalendar(
    @Param('id') id: string,
    @Body() dto: UpdateCalendarDto,
  ) {
    return this.calendarService.updateCalendar(id, dto);
  }

  @Post(':id/holidays')
  @SkipTenantCheck()
  async addHoliday(
    @Param('id') id: string,
    @Body() dto: CreateHolidayDto,
  ) {
    return this.calendarService.addHoliday(id, dto);
  }

  @Get(':id/holidays')
  @SkipTenantCheck()
  async listHolidays(@Param('id') id: string) {
    return this.calendarService.listHolidays(id);
  }
}
