import { SetMetadata, applyDecorators } from '@nestjs/common';
import { IS_PUBLIC_KEY, SKIP_TENANT_CHECK_KEY } from '../constants/context.constants';

/**
 * Marks an endpoint as public, skipping both authentication and tenant scoping guards.
 */
export const Public = () => applyDecorators(
  SetMetadata(IS_PUBLIC_KEY, true),
  SetMetadata(SKIP_TENANT_CHECK_KEY, true),
);

/**
 * Skips tenant header verification on endpoints that are system-wide or tenant-creating.
 */
export const SkipTenantCheck = () => SetMetadata(SKIP_TENANT_CHECK_KEY, true);
