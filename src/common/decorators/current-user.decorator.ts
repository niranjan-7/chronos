import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AppClsStore } from '../context/app-cls.store';
import { CLS_USER_ID } from '../constants/context.constants';

export const CurrentUser = createParamDecorator(
  (field: 'userId' | 'roles' | undefined, ctx: ExecutionContext) => {
    try {
      const cls = ClsServiceManager.getClsService<AppClsStore>();
      if (field === 'userId') {
        return cls.get(CLS_USER_ID);
      }
      if (field === 'roles') {
        return cls.get('userRoles');
      }
      return {
        userId: cls.get(CLS_USER_ID),
        roles: cls.get('userRoles'),
        jwtClaims: cls.get('jwtClaims'),
      };
    } catch {
      const request = ctx.switchToHttp().getRequest();
      return request.user;
    }
  },
);
