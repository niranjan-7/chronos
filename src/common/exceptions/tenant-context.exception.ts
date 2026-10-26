import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';

export class TenantContextMissingException extends UnauthorizedException {
  constructor(message = 'Tenant context is missing. Provide a valid x-tenant-id header or authenticated tenant token.') {
    super({
      statusCode: 401,
      error: 'TenantContextMissing',
      message,
    });
  }
}

export class InvalidTenantIdException extends BadRequestException {
  constructor(tenantId: string) {
    super({
      statusCode: 400,
      error: 'InvalidTenantId',
      message: `The provided tenant ID '${tenantId}' is not a valid UUID format.`,
    });
  }
}

export class TenantAccessDeniedException extends ForbiddenException {
  constructor(message = 'Access denied: Token tenant claim does not match the requested tenant context.') {
    super({
      statusCode: 403,
      error: 'TenantAccessDenied',
      message,
    });
  }
}
