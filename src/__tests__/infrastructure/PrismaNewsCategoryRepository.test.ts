/**
 * PrismaNewsCategoryRepository — adapter unit tests with mocked Prisma client
 * (review fixes M1/M2/L5).
 *
 * - update() previously swallowed ALL errors to null (M1) — a DB outage made the use case
 *   throw NewsCategoryNotFoundError (false 404) instead of surfacing the real failure.
 * - delete() previously swallowed ALL errors silently (M2) — a P2003 FK-RESTRICT race (a post
 *   created between DeleteNewsCategory's countPosts() check and this delete()) made the route
 *   respond 204 while the category (and the post referencing it) were still alive.
 * - create()/update() didn't map P2002 (L5) — a concurrent create/rename racing past the use
 *   case's findByName TOCTOU check surfaced as an unmapped 500 instead of a 409.
 *
 * Fixed contract:
 *   - create(): P2002 → NewsCategoryNameConflictError; anything else → rethrow.
 *   - update(): P2025 → null; P2002 → NewsCategoryNameConflictError; anything else → rethrow.
 *   - delete(): P2025 → no-op (idempotent, molde PrismaTaskAttachmentRepository); P2003 →
 *     NewsCategoryInUseError; anything else → rethrow.
 *
 * Pattern mirrors PrismaServiceCatalogRepository.test.ts (FF-2).
 */
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    newsCategory: {
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    newsPost: {
      count: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaNewsCategoryRepository } from '../../infrastructure/adapters/prisma/PrismaNewsCategoryRepository';
import { NewsCategoryNameConflictError, NewsCategoryInUseError } from '../../domain/errors/news';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as any;

describe('PrismaNewsCategoryRepository.create — error mapping (L5)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws NewsCategoryNameConflictError on P2002 (TOCTOU race past the use case check)', async () => {
    mockPrisma.newsCategory.create.mockRejectedValue({ code: 'P2002' });
    const repo = new PrismaNewsCategoryRepository();
    await expect(repo.create({ name: 'Comercial', color: '#10b981' })).rejects.toBeInstanceOf(
      NewsCategoryNameConflictError,
    );
  });

  it('rethrows a NON-P2002 error', async () => {
    const boom = new Error('connection reset');
    mockPrisma.newsCategory.create.mockRejectedValue(boom);
    const repo = new PrismaNewsCategoryRepository();
    await expect(repo.create({ name: 'X', color: '#111111' })).rejects.toBe(boom);
  });
});

describe('PrismaNewsCategoryRepository.update — error mapping (M1/L5)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns null on P2025 (record not found)', async () => {
    mockPrisma.newsCategory.update.mockRejectedValue({ code: 'P2025' });
    const repo = new PrismaNewsCategoryRepository();
    await expect(repo.update('missing', { name: 'X' })).resolves.toBeNull();
  });

  it('throws NewsCategoryNameConflictError on P2002 (TOCTOU race past the use case check)', async () => {
    mockPrisma.newsCategory.update.mockRejectedValue({ code: 'P2002' });
    const repo = new PrismaNewsCategoryRepository();
    await expect(repo.update('cat-1', { name: 'Comercial' })).rejects.toBeInstanceOf(
      NewsCategoryNameConflictError,
    );
  });

  it('rethrows a NON-P2025/P2002 error instead of swallowing it to null', async () => {
    const boom = new Error('connection reset');
    mockPrisma.newsCategory.update.mockRejectedValue(boom);
    const repo = new PrismaNewsCategoryRepository();
    await expect(repo.update('cat-1', { name: 'X' })).rejects.toBe(boom);
  });
});

describe('PrismaNewsCategoryRepository.delete — error mapping (M2)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is idempotent: P2025 (record not found) is swallowed → no throw', async () => {
    mockPrisma.newsCategory.delete.mockRejectedValue({ code: 'P2025' });
    const repo = new PrismaNewsCategoryRepository();
    await expect(repo.delete('ghost')).resolves.toBeUndefined();
  });

  it('throws NewsCategoryInUseError on P2003 (FK RESTRICT race) instead of a false 204', async () => {
    mockPrisma.newsCategory.delete.mockRejectedValue({ code: 'P2003' });
    mockPrisma.newsPost.count.mockResolvedValue(1);
    const repo = new PrismaNewsCategoryRepository();
    await expect(repo.delete('cat-1')).rejects.toBeInstanceOf(NewsCategoryInUseError);
  });

  it('rethrows a NON-P2025/P2003 error instead of swallowing it silently', async () => {
    const boom = new Error('connection reset');
    mockPrisma.newsCategory.delete.mockRejectedValue(boom);
    const repo = new PrismaNewsCategoryRepository();
    await expect(repo.delete('cat-1')).rejects.toBe(boom);
  });
});
