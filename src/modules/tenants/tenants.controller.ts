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
import { TenantsService } from './tenants.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { SkipTenantCheck } from '../../common/decorators/public.decorator';

@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

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
}
