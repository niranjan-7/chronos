import { ClsService } from 'nestjs-cls';
import {
  TenantAwareRepository,
  TenantScopedPrismaDelegate,
} from './tenant-aware.repository';
import { TenantContextMissingException } from '../exceptions/tenant-context.exception';

interface TestEntity {
  id: string;
  tenantId: string;
  name: string;
}

class TestRepository extends TenantAwareRepository<TestEntity> {
  constructor(delegate: TenantScopedPrismaDelegate<any, any, any, any, any, any>, cls: ClsService<any>) {
    super(delegate, cls, 'TestEntity');
  }
}

describe('TenantAwareRepository', () => {
  let repository: TestRepository;
  let mockDelegate: jest.Mocked<TenantScopedPrismaDelegate<any, any, any, any, any, any>>;
  let mockCls: jest.Mocked<ClsService<any>>;

  const mockTenantId = 'tenant-uuid-1234';

  beforeEach(() => {
    mockDelegate = {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      count: jest.fn(),
    };

    mockCls = {
      get: jest.fn().mockImplementation((key) => {
        if (key === 'tenantId') return mockTenantId;
        if (key === 'isSystemOperation') return false;
        return undefined;
      }),
      runWith: jest.fn(),
    } as unknown as jest.Mocked<ClsService<any>>;

    repository = new TestRepository(mockDelegate, mockCls);
  });

  it('should throw TenantContextMissingException if tenantId is missing in CLS', () => {
    mockCls.get.mockReturnValue(undefined);

    expect(() => repository.getTenantId()).toThrow(TenantContextMissingException);
  });

  it('should automatically inject tenantId into findMany query', async () => {
    mockDelegate.findMany.mockResolvedValue([]);

    await repository.findMany({ where: { name: 'Sample' } });

    expect(mockDelegate.findMany).toHaveBeenCalledWith({
      where: {
        name: 'Sample',
        tenantId: mockTenantId,
      },
    });
  });

  it('should automatically inject tenantId into findFirst query', async () => {
    mockDelegate.findFirst.mockResolvedValue(null);

    await repository.findFirst({ where: { name: 'Sample' } });

    expect(mockDelegate.findFirst).toHaveBeenCalledWith({
      where: {
        name: 'Sample',
        tenantId: mockTenantId,
      },
    });
  });

  it('should scope findById strictly to the active tenant to prevent cross-tenant lookup', async () => {
    const entity: TestEntity = { id: 'ent-1', tenantId: mockTenantId, name: 'Item' };
    mockDelegate.findFirst.mockResolvedValue(entity);

    const result = await repository.findById('ent-1');

    expect(mockDelegate.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'ent-1',
        tenantId: mockTenantId,
      },
    });
    expect(result).toEqual(entity);
  });

  it('should automatically inject tenantId on create', async () => {
    const created: TestEntity = { id: 'ent-2', tenantId: mockTenantId, name: 'New Item' };
    mockDelegate.create.mockResolvedValue(created);

    const result = await repository.create({ data: { name: 'New Item' } });

    expect(mockDelegate.create).toHaveBeenCalledWith({
      data: {
        name: 'New Item',
        tenantId: mockTenantId,
      },
    });
    expect(result).toEqual(created);
  });

  it('should prevent updateById if record belongs to another tenant', async () => {
    mockDelegate.findFirst.mockResolvedValue(null); // record not found in this tenant

    await expect(repository.updateById('foreign-id', { name: 'Hacked' })).rejects.toThrow(
      "Record 'foreign-id' in 'TestEntity' not found or belongs to another tenant.",
    );
    expect(mockDelegate.update).not.toHaveBeenCalled();
  });

  it('should prevent deleteById if record belongs to another tenant', async () => {
    mockDelegate.findFirst.mockResolvedValue(null); // record not found in this tenant

    await expect(repository.deleteById('foreign-id')).rejects.toThrow(
      "Record 'foreign-id' in 'TestEntity' not found or belongs to another tenant.",
    );
    expect(mockDelegate.delete).not.toHaveBeenCalled();
  });

  it('should automatically inject tenantId into count queries', async () => {
    mockDelegate.count.mockResolvedValue(42);

    const count = await repository.count({ name: 'Active' });

    expect(mockDelegate.count).toHaveBeenCalledWith({
      where: {
        name: 'Active',
        tenantId: mockTenantId,
      },
    });
    expect(count).toBe(42);
  });
});
