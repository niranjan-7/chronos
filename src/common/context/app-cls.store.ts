import { ClsStore } from 'nestjs-cls';

export interface AppClsStore extends ClsStore {
  tenantId?: string;
  userId?: string;
  userRoles?: string[];
  requestId?: string;
  isSystemOperation?: boolean;
  jwtClaims?: Record<string, unknown>;
}
