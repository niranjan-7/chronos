import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { TenantContextGuard } from './guards/tenant-context.guard';
import { TenantInterceptor } from './interceptors/tenant-context.interceptor';

@Global()
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
  ],
  providers: [
    TenantContextGuard,
    TenantInterceptor,
    {
      provide: APP_GUARD,
      useClass: TenantContextGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: TenantInterceptor,
    },
  ],
  exports: [DatabaseModule, TenantContextGuard, TenantInterceptor],
})
export class CommonModule {}
