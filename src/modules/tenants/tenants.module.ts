import { Module } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { TenantsController } from './tenants.controller';
import { TenantCalendarService } from './services/tenant-calendar.service';

@Module({
  controllers: [TenantsController],
  providers: [TenantsService, TenantCalendarService],
  exports: [TenantsService, TenantCalendarService],
})
export class TenantsModule {}
