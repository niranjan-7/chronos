import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AppClsStore } from '../context/app-cls.store';
import { CLS_TENANT_ID } from '../constants/context.constants';

export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    // 1. First attempt to read from CLS store (thread-safe AsyncLocalStorage)
    try {
      const cls = ClsServiceManager.getClsService<AppClsStore>();
      const tenantId = cls.get(CLS_TENANT_ID);
      if (tenantId) {
        return tenantId;
      }
    } catch {
      // Cls context may not be active in non-HTTP tests
    }

    // 2. Fallback to request property set by guard/interceptor
    const request = ctx.switchToHttp().getRequest();
    return request.tenantId ?? request.headers?.['x-tenant-id'];
  },
);
