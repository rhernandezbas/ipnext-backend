/**
 * PrismaPortalSessionRepository.markRotated — adapter unit test with an injected
 * stub db (re-review fix, espejo del contrato in-memory).
 *
 * El CAS de rotación tiene que perder no solo contra OTRA rotación
 * (`rotatedAt: null`) sino también contra una REVOCACIÓN concurrente
 * (`revokedAt: null`): change-password / logout global revocan la fila entre el
 * findByTokenHash del refresh y este updateMany. Si el WHERE no exige
 * `revokedAt: null`, el updateMany "gana" sobre una sesión ya revocada y el use
 * case mintea una cadena nueva colgando de una cuenta recién saneada.
 */
jest.mock('../../infrastructure/database/prisma', () => ({ prisma: {} }));

import { PrismaPortalSessionRepository } from '@infrastructure/adapters/prisma/PrismaPortalSessionRepository';

type UpdateManyArgs = { where: Record<string, unknown>; data: Record<string, unknown> };

function makeRepoCapturing(count: number) {
  const calls: UpdateManyArgs[] = [];
  const db = {
    portalSession: {
      updateMany: async (args: UpdateManyArgs) => {
        calls.push(args);
        return { count };
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { repo: new PrismaPortalSessionRepository(db as any), calls };
}

describe('PrismaPortalSessionRepository.markRotated — CAS revocar-vs-rotar', () => {
  it('el WHERE del updateMany exige la fila VIVA: rotatedAt null Y revokedAt null', async () => {
    const { repo, calls } = makeRepoCapturing(1);

    await repo.markRotated('sess-1');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.where).toEqual({ id: 'sess-1', rotatedAt: null, revokedAt: null });
    expect(calls[0]!.data).toEqual({ rotatedAt: expect.any(Date) });
  });

  it('count === 1 → true (ganó la carrera); count === 0 → false (rotada O revocada en el medio)', async () => {
    await expect(makeRepoCapturing(1).repo.markRotated('sess-1')).resolves.toBe(true);
    await expect(makeRepoCapturing(0).repo.markRotated('sess-1')).resolves.toBe(false);
  });
});
