import { Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AppClsStore } from '../context/app-cls.store';
import { CLS_IS_SYSTEM, CLS_TENANT_ID } from '../constants/context.constants';
import { TenantContextMissingException } from '../exceptions/tenant-context.exception';

/**
 * Interface representing a standard Prisma delegate for a tenant-scoped model.
 */
export interface TenantScopedPrismaDelegate<TModel, TFindManyArgs, TFindFirstArgs, TCreateArgs, TUpdateArgs, TDeleteArgs> {
  findMany(args?: TFindManyArgs): Promise<TModel[]>;
  findFirst(args?: TFindFirstArgs): Promise<TModel | null>;
  create(args: TCreateArgs): Promise<TModel>;
  update(args: TUpdateArgs): Promise<TModel>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  delete(args: TDeleteArgs): Promise<TModel>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  count(args?: { where?: Record<string, unknown> }): Promise<number>;
}

/**
 * Type helper that makes `tenantId` optional for callers because the repository injects it automatically.
 */
export type TenantScopedInput<T> = Omit<T, 'tenantId' | 'tenant'> & {
  tenantId?: string;
  tenant?: unknown;
};

/**
 * Base Tenant-Aware Repository Wrapper.
 * Automatically injects `tenantId` from AsyncLocalStorage (nestjs-cls)
 * into all database queries to strictly prevent cross-tenant data leakage.
 */
export abstract class TenantAwareRepository<
  TModel extends { id: string; tenantId: string },
  TFindManyArgs extends { where?: Record<string, unknown> } = { where?: Record<string, unknown> },
  TFindFirstArgs extends { where?: Record<string, unknown> } = { where?: Record<string, unknown> },
  TCreateArgs extends { data: Record<string, unknown> } = { data: Record<string, unknown> },
  TUpdateArgs extends { where: Record<string, unknown>; data: Record<string, unknown> } = { where: Record<string, unknown>; data: Record<string, unknown> },
  TDeleteArgs extends { where: Record<string, unknown> } = { where: Record<string, unknown> },
> {
  protected readonly logger = new Logger(this.constructor.name);

  constructor(
    protected readonly delegate: TenantScopedPrismaDelegate<
      TModel,
      TFindManyArgs,
      TFindFirstArgs,
      TCreateArgs,
      TUpdateArgs,
      TDeleteArgs
    >,
    protected readonly cls: ClsService<AppClsStore>,
    protected readonly entityName: string,
  ) {}

  /**
   * Retrieves the active tenantId from CLS.
   * Throws TenantContextMissingException if not in system mode and tenant is absent.
   */
  public getTenantId(): string {
    const isSystem = this.cls.get(CLS_IS_SYSTEM);
    if (isSystem) {
      const explicitTenant = this.cls.get(CLS_TENANT_ID);
      if (explicitTenant) return explicitTenant;
    }

    const tenantId = this.cls.get(CLS_TENANT_ID);
    if (!tenantId) {
      throw new TenantContextMissingException(
        `Multi-tenant isolation violation: Active tenant context is required for database operations on '${this.entityName}'.`,
      );
    }
    return tenantId;
  }

  /**
   * Executes a database query ensuring that where condition includes `tenantId`.
   */
  async findMany(args: TFindManyArgs = {} as TFindManyArgs): Promise<TModel[]> {
    const tenantId = this.getTenantId();
    const scopedArgs = {
      ...args,
      where: {
        ...(args.where || {}),
        tenantId,
      },
    } as unknown as TFindManyArgs;

    return this.delegate.findMany(scopedArgs);
  }

  /**
   * Finds the first entity matching the criteria strictly within the current tenant.
   */
  async findFirst(args: TFindFirstArgs = {} as TFindFirstArgs): Promise<TModel | null> {
    const tenantId = this.getTenantId();
    const scopedArgs = {
      ...args,
      where: {
        ...(args.where || {}),
        tenantId,
      },
    } as unknown as TFindFirstArgs;

    return this.delegate.findFirst(scopedArgs);
  }

  /**
   * Finds an entity by its UUID primary key, strictly scoped to the active tenant.
   * Prevents leaking records of other tenants via guessed UUIDs.
   */
  async findById(id: string, include?: Record<string, unknown>): Promise<TModel | null> {
    const tenantId = this.getTenantId();
    const query: Record<string, unknown> = {
      where: {
        id,
        tenantId,
      },
    };
    if (include) {
      query.include = include;
    }
    return this.delegate.findFirst(query as unknown as TFindFirstArgs);
  }

  /**
   * Creates a new entity with automatic injection of the active `tenantId`.
   * Accepts caller payload where `tenantId` is omitted or optional.
   */
  async create<TData extends Record<string, unknown>>(
    args: { data: TenantScopedInput<TData>; select?: unknown; include?: unknown },
  ): Promise<TModel> {
    const tenantId = this.getTenantId();
    const scopedArgs = {
      ...args,
      data: {
        ...args.data,
        tenantId,
      },
    } as unknown as TCreateArgs;

    return this.delegate.create(scopedArgs);
  }

  /**
   * Updates an entity by primary key, verifying tenant ownership before applying changes.
   */
  async updateById(id: string, data: Record<string, unknown>): Promise<TModel> {
    const tenantId = this.getTenantId();

    // 1. Verify existence in current tenant
    const existing = await this.delegate.findFirst({
      where: { id, tenantId },
    } as unknown as TFindFirstArgs);

    if (!existing) {
      throw new Error(`Record '${id}' in '${this.entityName}' not found or belongs to another tenant.`);
    }

    // 2. Perform safe update
    return this.delegate.update({
      where: { id },
      data,
    } as unknown as TUpdateArgs);
  }

  /**
   * Deletes an entity by primary key, strictly scoped to current tenant.
   */
  async deleteById(id: string): Promise<TModel> {
    const tenantId = this.getTenantId();

    // 1. Verify existence in current tenant
    const existing = await this.delegate.findFirst({
      where: { id, tenantId },
    } as unknown as TFindFirstArgs);

    if (!existing) {
      throw new Error(`Record '${id}' in '${this.entityName}' not found or belongs to another tenant.`);
    }

    return this.delegate.delete({
      where: { id },
    } as unknown as TDeleteArgs);
  }

  /**
   * Counts entities matching criteria strictly within the current tenant.
   */
  async count(where: Record<string, unknown> = {}): Promise<number> {
    const tenantId = this.getTenantId();
    return this.delegate.count({
      where: {
        ...where,
        tenantId,
      },
    });
  }

  /**
   * Executes a callback within a system context (bypasses tenant scoping for background workers/cron).
   */
  async runAsSystem<R>(callback: () => Promise<R>): Promise<R> {
    return this.cls.runWith({ isSystemOperation: true } as AppClsStore, callback);
  }

  /**
   * Executes a callback within a specific tenant context (useful for event consumers / background workers).
   */
  async withTenant<R>(tenantId: string, callback: () => Promise<R>): Promise<R> {
    return this.cls.runWith({ tenantId, isSystemOperation: false } as AppClsStore, callback);
  }
}
