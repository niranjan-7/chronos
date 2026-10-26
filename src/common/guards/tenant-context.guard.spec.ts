import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { TenantContextGuard } from './tenant-context.guard';
import {
  InvalidTenantIdException,
  TenantAccessDeniedException,
  TenantContextMissingException,
} from '../exceptions/tenant-context.exception';
import * as jwt from 'jsonwebtoken';

describe('TenantContextGuard', () => {
  let guard: TenantContextGuard;
  let reflector: jest.Mocked<Reflector>;
  let cls: jest.Mocked<ClsService<any>>;
  let configService: jest.Mocked<ConfigService>;

  const mockTenantId = '11111111-1111-4111-8111-111111111111';
  const otherTenantId = '22222222-2222-4222-8222-222222222222';
  const jwtSecret = 'test-secret';

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn(),
    } as unknown as jest.Mocked<Reflector>;

    cls = {
      set: jest.fn(),
      get: jest.fn(),
      getId: jest.fn().mockReturnValue('req-123'),
    } as unknown as jest.Mocked<ClsService<any>>;

    configService = {
      get: jest.fn().mockReturnValue(jwtSecret),
    } as unknown as jest.Mocked<ConfigService>;

    guard = new TenantContextGuard(reflector, cls, configService);
  });

  function createMockContext(headers: Record<string, string>): ExecutionContext {
    const request = {
      headers,
      id: 'req-123',
    };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({}),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  }

  it('should allow access if route is marked public', () => {
    reflector.getAllAndOverride.mockImplementation((key) => {
      return key === 'isPublic';
    });

    const context = createMockContext({});
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow access if route is marked skipTenantCheck', () => {
    reflector.getAllAndOverride.mockImplementation((key) => {
      return key === 'skipTenantCheck';
    });

    const context = createMockContext({});
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should throw TenantContextMissingException when x-tenant-id and auth token are absent', () => {
    reflector.getAllAndOverride.mockReturnValue(false);

    const context = createMockContext({});
    expect(() => guard.canActivate(context)).toThrow(TenantContextMissingException);
  });

  it('should throw InvalidTenantIdException if x-tenant-id is not a valid UUID', () => {
    reflector.getAllAndOverride.mockReturnValue(false);

    const context = createMockContext({ 'x-tenant-id': 'invalid-uuid-string' });
    expect(() => guard.canActivate(context)).toThrow(InvalidTenantIdException);
  });

  it('should successfully bind tenantId to CLS store with valid x-tenant-id header', () => {
    reflector.getAllAndOverride.mockReturnValue(false);

    const context = createMockContext({ 'x-tenant-id': mockTenantId });
    const result = guard.canActivate(context);

    expect(result).toBe(true);
    expect(cls.set).toHaveBeenCalledWith('tenantId', mockTenantId);
    expect(cls.set).toHaveBeenCalledWith('isSystemOperation', false);
  });

  it('should extract tenant from JWT token when header is missing', () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const token = jwt.sign({ tenantId: mockTenantId, sub: 'user-1' }, jwtSecret);

    const context = createMockContext({ authorization: `Bearer ${token}` });
    const result = guard.canActivate(context);

    expect(result).toBe(true);
    expect(cls.set).toHaveBeenCalledWith('tenantId', mockTenantId);
    expect(cls.set).toHaveBeenCalledWith('userId', 'user-1');
  });

  it('should throw TenantAccessDeniedException if header tenantId differs from JWT claim', () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const token = jwt.sign({ tenantId: mockTenantId, sub: 'user-1' }, jwtSecret);

    const context = createMockContext({
      'x-tenant-id': otherTenantId,
      authorization: `Bearer ${token}`,
    });

    expect(() => guard.canActivate(context)).toThrow(TenantAccessDeniedException);
  });
});
