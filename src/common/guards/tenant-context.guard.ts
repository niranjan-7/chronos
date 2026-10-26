import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import * as jwt from 'jsonwebtoken';
import { AppClsStore } from '../context/app-cls.store';
import {
  AUTHORIZATION_HEADER,
  CLS_IS_SYSTEM,
  CLS_JWT_CLAIMS,
  CLS_REQUEST_ID,
  CLS_TENANT_ID,
  CLS_USER_ID,
  CLS_USER_ROLES,
  IS_PUBLIC_KEY,
  REQUEST_ID_HEADER,
  SKIP_TENANT_CHECK_KEY,
  TENANT_HEADER,
} from '../constants/context.constants';
import {
  InvalidTenantIdException,
  TenantAccessDeniedException,
  TenantContextMissingException,
} from '../exceptions/tenant-context.exception';

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface DecodedJwtPayload {
  sub?: string;
  userId?: string;
  tenantId?: string;
  tenant_id?: string;
  roles?: string[];
  role?: string;
  [key: string]: unknown;
}

@Injectable()
export class TenantContextGuard implements CanActivate {
  private readonly logger = new Logger(TenantContextGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly cls: ClsService<AppClsStore>,
    private readonly configService: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const skipTenantCheck = this.reflector.getAllAndOverride<boolean>(
      SKIP_TENANT_CHECK_KEY,
      [context.getHandler(), context.getClass()],
    );

    const request = context.switchToHttp().getRequest();
    const requestId =
      (request.headers[REQUEST_ID_HEADER] as string) ||
      (request.id as string) ||
      this.cls.getId?.();

    if (requestId) {
      this.cls.set(CLS_REQUEST_ID, requestId);
    }

    // 1. Process JWT token if present
    const authHeader = request.headers[AUTHORIZATION_HEADER] as string | undefined;
    let jwtTenantId: string | undefined;
    let jwtUserId: string | undefined;
    let jwtRoles: string[] = [];
    let jwtClaims: Record<string, unknown> | undefined;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7).trim();
      const decoded = this.extractAndVerifyJwt(token);
      if (decoded) {
        jwtTenantId = (decoded.tenantId || decoded.tenant_id) as string | undefined;
        jwtUserId = (decoded.userId || decoded.sub) as string | undefined;
        if (decoded.roles && Array.isArray(decoded.roles)) {
          jwtRoles = decoded.roles as string[];
        } else if (decoded.role && typeof decoded.role === 'string') {
          jwtRoles = [decoded.role];
        }
        jwtClaims = decoded;
      }
    }

    // 2. Extract header tenant ID
    const rawHeaderTenantId = request.headers[TENANT_HEADER];
    const headerTenantId = Array.isArray(rawHeaderTenantId)
      ? rawHeaderTenantId[0]
      : rawHeaderTenantId;

    // 3. Prevent cross-tenant spoofing: if both exist, they MUST match
    if (jwtTenantId && headerTenantId && jwtTenantId !== headerTenantId) {
      this.logger.warn(
        `Cross-tenant access attempt detected! Header: ${headerTenantId}, JWT: ${jwtTenantId}`,
      );
      throw new TenantAccessDeniedException();
    }

    // Resolved Tenant ID (prefer explicit header, or fallback to JWT claim)
    const resolvedTenantId = headerTenantId || jwtTenantId;

    // 4. If public or skip tenant check, allow request through even without tenant
    if (isPublic || skipTenantCheck) {
      if (resolvedTenantId && UUID_V4_REGEX.test(resolvedTenantId)) {
        this.bindContext(resolvedTenantId, jwtUserId, jwtRoles, jwtClaims, request);
      }
      return true;
    }

    // 5. Tenant context is mandatory for tenant-scoped endpoints
    if (!resolvedTenantId) {
      throw new TenantContextMissingException(
        `Missing required '${TENANT_HEADER}' header or valid tenant claim in authorization token.`,
      );
    }

    if (!UUID_V4_REGEX.test(resolvedTenantId)) {
      throw new InvalidTenantIdException(resolvedTenantId);
    }

    // 6. Bind to AsyncLocalStorage and request object
    this.bindContext(resolvedTenantId, jwtUserId, jwtRoles, jwtClaims, request);

    return true;
  }

  private bindContext(
    tenantId: string,
    userId: string | undefined,
    roles: string[],
    jwtClaims: Record<string, unknown> | undefined,
    request: Record<string, unknown>,
  ): void {
    this.cls.set(CLS_TENANT_ID, tenantId);
    this.cls.set(CLS_IS_SYSTEM, false);

    if (userId) {
      this.cls.set(CLS_USER_ID, userId);
    }
    if (roles && roles.length > 0) {
      this.cls.set(CLS_USER_ROLES, roles);
    }
    if (jwtClaims) {
      this.cls.set(CLS_JWT_CLAIMS, jwtClaims);
    }

    // Attach to request object for easy debugging/inspection
    request.tenantId = tenantId;
    request.user = {
      userId,
      roles,
      tenantId,
      jwtClaims,
    };
  }

  private extractAndVerifyJwt(token: string): DecodedJwtPayload | null {
    const jwtSecret = this.configService.get<string>('JWT_SECRET');
    try {
      if (jwtSecret) {
        return jwt.verify(token, jwtSecret) as DecodedJwtPayload;
      }
      // If secret not configured yet, decode without verification in dev/permissive mode
      return jwt.decode(token) as DecodedJwtPayload;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn(`JWT verification error: ${errorMessage}`);
      return null;
    }
  }
}
