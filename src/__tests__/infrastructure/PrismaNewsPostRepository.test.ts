/**
 * PrismaNewsPostRepository — adapter unit tests with mocked Prisma client (review fix M1).
 *
 * update()/setArchived() previously swallowed ALL errors to null (`catch { return null; }`).
 * A DB outage or an unrelated constraint violation made the use case throw
 * NewsPostNotFoundError — a false 404 instead of surfacing the real failure. The adapter
 * must distinguish:
 *   - P2025 (record not found) → null (the ONLY legitimate null path)
 *   - any other error         → rethrow (never silently null)
 *
 * Pattern mirrors PrismaServiceCatalogRepository.test.ts (FF-2) / PrismaTaskAttachmentRepository.test.ts.
 */
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    newsPost: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    newsReadReceipt: {
      upsert: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaNewsPostRepository } from '../../infrastructure/adapters/prisma/PrismaNewsPostRepository';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as any;

describe('PrismaNewsPostRepository.update — error mapping (M1)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns null on P2025 (record not found)', async () => {
    mockPrisma.newsPost.update.mockRejectedValue({ code: 'P2025' });
    const repo = new PrismaNewsPostRepository();
    await expect(repo.update('missing', { title: 'X' })).resolves.toBeNull();
  });

  it('rethrows a NON-P2025 error instead of swallowing it to null', async () => {
    const boom = new Error('connection reset');
    mockPrisma.newsPost.update.mockRejectedValue(boom);
    const repo = new PrismaNewsPostRepository();
    await expect(repo.update('id-1', { title: 'X' })).rejects.toBe(boom);
  });
});

describe('PrismaNewsPostRepository.setArchived — error mapping (M1)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns null on P2025 (record not found)', async () => {
    mockPrisma.newsPost.update.mockRejectedValue({ code: 'P2025' });
    const repo = new PrismaNewsPostRepository();
    await expect(repo.setArchived('missing', true)).resolves.toBeNull();
  });

  it('rethrows a NON-P2025 error instead of swallowing it to null', async () => {
    const boom = new Error('connection reset');
    mockPrisma.newsPost.update.mockRejectedValue(boom);
    const repo = new PrismaNewsPostRepository();
    await expect(repo.setArchived('id-1', true)).rejects.toBe(boom);
  });
});
