import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { ClsService } from 'nestjs-cls';
import { AppClsStore } from '../context/app-cls.store';
import {
  CLS_REQUEST_ID,
  CLS_TENANT_ID,
  REQUEST_ID_HEADER,
  TENANT_HEADER,
} from '../constants/context.constants';

@Injectable()
export class TenantInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TenantInterceptor.name);

  constructor(private readonly cls: ClsService<AppClsStore>) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();

    const tenantId = this.cls.get(CLS_TENANT_ID) || req.tenantId;
    const requestId = this.cls.get(CLS_REQUEST_ID) || req.headers[REQUEST_ID_HEADER];

    // Inject tenant & request correlation headers into response
    if (tenantId && res && typeof res.setHeader === 'function') {
      res.setHeader(TENANT_HEADER, tenantId);
    }
    if (requestId && res && typeof res.setHeader === 'function') {
      res.setHeader(REQUEST_ID_HEADER, requestId);
    }

    const start = Date.now();
    const method = req.method;
    const url = req.originalUrl || req.url;

    return next.handle().pipe(
      tap({
        next: () => {
          const duration = Date.now() - start;
          const status = res?.statusCode || 200;
          this.logger.debug(
            `[${method}] ${url} ${status} - ${duration}ms [tenant: ${tenantId ?? 'global'}, req: ${requestId ?? '-'}]`,
          );
        },
        error: (err) => {
          const duration = Date.now() - start;
          this.logger.error(
            `[${method}] ${url} FAILED - ${duration}ms [tenant: ${tenantId ?? 'global'}, req: ${requestId ?? '-'}] - ${err.message}`,
          );
        },
      }),
    );
  }
}
