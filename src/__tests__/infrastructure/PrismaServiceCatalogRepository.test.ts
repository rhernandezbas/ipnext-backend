/**
 * PrismaServiceCatalogRepository — adapter unit tests with mocked Prisma client.
 *
 * FF-2: update() previously swallowed ALL errors to null (catch → null). A concurrent
 * rename hitting the UNIQUE(name) index throws P2002; swallowing it to null made the
 * use-case translate the conflict into a bogus 404 (SERVICE_CATALOG_NOT_FOUND) instead
 * of a 409. The adapter must distinguish:
 *   - P2002 (unique name collision)  → throw ServiceCatalogNameConflictError (→ 409)
 *   - P2025 (record not found)       → null (genuine not-found)
 *   - any other error                → rethrow (never silently null)
 *
 * Pattern mirrors PrismaNetworkSiteRepository.test.ts (jest.mock at module level).
 */

jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    serviceCatalog: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      delete: jest.fn(),
    },
    contractService: {
      count: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaServiceCatalogRepository } from '../../infrastructure/adapters/prisma/PrismaServiceCatalogRepository';
import { ServiceCatalogNameConflictError } from '../../domain/errors/contractServices';

const mockPrisma = prisma as any;

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sc-1',
    name: 'INTERNET',
    label: null,
    active: true,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('PrismaServiceCatalogRepository.update — error mapping (FF-2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rethrows P2002 (unique name collision) as ServiceCatalogNameConflictError', async () => {
    (mockPrisma.serviceCatalog.update as jest.Mock).mockRejectedValue({ code: 'P2002' });
    const repo = new PrismaServiceCatalogRepository();
    await expect(repo.update('sc-1', { name: 'TV' })).rejects.toBeInstanceOf(
      ServiceCatalogNameConflictError,
    );
  });

  it('returns null on P2025 (record not found)', async () => {
    (mockPrisma.serviceCatalog.update as jest.Mock).mockRejectedValue({ code: 'P2025' });
    const repo = new PrismaServiceCatalogRepository();
    await expect(repo.update('nope', { label: 'x' })).resolves.toBeNull();
  });

  it('rethrows any other error (never silently null)', async () => {
    const boom = new Error('connection reset');
    (mockPrisma.serviceCatalog.update as jest.Mock).mockRejectedValue(boom);
    const repo = new PrismaServiceCatalogRepository();
    await expect(repo.update('sc-1', { label: 'x' })).rejects.toBe(boom);
  });

  it('returns the mapped view on success', async () => {
    (mockPrisma.serviceCatalog.update as jest.Mock).mockResolvedValue(makeRow({ label: 'Internet' }));
    const repo = new PrismaServiceCatalogRepository();
    const result = await repo.update('sc-1', { label: 'Internet' });
    expect(result?.id).toBe('sc-1');
    expect(result?.label).toBe('Internet');
  });
});
