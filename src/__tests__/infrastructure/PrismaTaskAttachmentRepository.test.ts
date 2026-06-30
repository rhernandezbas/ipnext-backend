/**
 * Unit tests for PrismaTaskAttachmentRepository.delete (M2).
 * Mocks the Prisma singleton — no real DB. Pattern mirrors PrismaIClassSoTypeRepository.test.ts.
 *
 * Contract: delete() is idempotent ONLY for "record not found" (Prisma P2025).
 * Any OTHER error (connection drop, deadlock, …) MUST propagate — never be swallowed.
 */
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    scheduledTaskAttachment: {
      delete: jest.fn(),
    },
  },
}));

import { PrismaTaskAttachmentRepository } from '../../infrastructure/adapters/prisma/PrismaTaskAttachmentRepository';
import { prisma } from '../../infrastructure/database/prisma';

type MockPrisma = { scheduledTaskAttachment: { delete: jest.Mock } };
const mockPrisma = prisma as unknown as MockPrisma;

afterEach(() => jest.resetAllMocks());

describe('PrismaTaskAttachmentRepository.delete', () => {
  it('is idempotent: P2025 (record not found) is swallowed → no throw', async () => {
    mockPrisma.scheduledTaskAttachment.delete.mockRejectedValue(
      Object.assign(new Error('Record to delete does not exist.'), { code: 'P2025' }),
    );

    const repo = new PrismaTaskAttachmentRepository();
    await expect(repo.delete('ghost')).resolves.toBeUndefined();
  });

  it('propagates a NON-P2025 error (e.g. connection drop) instead of swallowing it', async () => {
    mockPrisma.scheduledTaskAttachment.delete.mockRejectedValue(
      Object.assign(new Error('Server has closed the connection.'), { code: 'P1017' }),
    );

    const repo = new PrismaTaskAttachmentRepository();
    await expect(repo.delete('a1')).rejects.toThrow('Server has closed the connection.');
  });
});
