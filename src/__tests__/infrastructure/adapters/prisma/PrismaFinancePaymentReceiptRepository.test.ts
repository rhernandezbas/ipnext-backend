import { PrismaFinancePaymentReceiptRepository } from '@infrastructure/adapters/prisma/PrismaFinancePaymentReceiptRepository';
import { prisma } from '@infrastructure/database/prisma';

/**
 * gr-receipt-annulment (design.md Decision 9) — `existingIds` runs ONE
 * `findMany({where:{grReceiptId:{in}}})`, never N queries. Spies on the REAL
 * Prisma class (molde `PrismaPortalPaymentsReader.test.ts`) since the
 * invariant ("one query, correct where") lives in the class that actually
 * runs in production.
 */
/**
 * gr-receipt-annulment fix-wave RF1 — the `update` branch of the upsert is
 * what decides whether an ALREADY-MIRRORED receipt can ever flip to
 * `anulado: true`. It used to omit the field entirely, so the reconcile
 * lane's whole reason to exist (catching an annulment GR reports on a receipt
 * the mirror already has) was decorative: the row never flipped, and the
 * ENTIRE suite stayed green with that mutant in place — nothing looked at the
 * shape of the write.
 *
 * The semantics pinned here are a ONE-WAY LATCH (fix-wave decision):
 *  - incoming `anulado: true`  → the update WRITES `anulado: true`.
 *  - incoming `anulado: false` → the update OMITS the field entirely, so an
 *    already-annulled row is NEVER silently un-annulled. A GR page that stops
 *    reporting `fecha_anulacion` (a format drift, a partial response) would
 *    otherwise collapse the whole mirror back to "not annulled" — the mass
 *    de-annulment R1 flagged as MEDIUM-5, the exact inverse of the bug the
 *    guard protects against, and invisible because it looks like healthy data.
 */
describe('PrismaFinancePaymentReceiptRepository.upsertBatch — the anulado latch (RF1)', () => {
  afterEach(() => jest.restoreAllMocks());

  function row(grReceiptId: string, anulado: boolean) {
    return {
      grReceiptId,
      clientGrId: '100011',
      recaudador: 'mercadopago',
      fechaRecibo: new Date('2026-08-05T03:00:00.000Z'),
      fechaConfirmacion: null,
      anulado,
      observaciones: null,
    };
  }

  function spyUpsert() {
    jest.spyOn(prisma, '$transaction').mockImplementation((async (ops: unknown) => ops) as never);
    return jest.spyOn(prisma.financePaymentReceipt, 'upsert').mockImplementation(((args: unknown) => args) as never);
  }

  it('an incoming anulado:true WRITES anulado:true in the `update` branch (not just in `create`)', async () => {
    const upsertSpy = spyUpsert();

    await new PrismaFinancePaymentReceiptRepository().upsertBatch([row('R1', true)]);

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    const args = upsertSpy.mock.calls[0][0] as unknown as { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> };
    expect(args.where).toEqual({ grReceiptId: 'R1' });
    expect(args.create.anulado).toBe(true);
    // THE pin: without this, a row already in the mirror never flips.
    expect(args.update).toHaveProperty('anulado', true);
  });

  it('an incoming anulado:false OMITS `anulado` from the `update` branch — the latch never un-annuls a row automatically', async () => {
    const upsertSpy = spyUpsert();

    await new PrismaFinancePaymentReceiptRepository().upsertBatch([row('R2', false)]);

    const args = upsertSpy.mock.calls[0][0] as unknown as { create: Record<string, unknown>; update: Record<string, unknown> };
    // `create` still carries the honest false — a brand-new row is not annulled.
    expect(args.create.anulado).toBe(false);
    // ...but the UPDATE must not touch the flag at all.
    expect(Object.prototype.hasOwnProperty.call(args.update, 'anulado')).toBe(false);
  });

  it('the non-annulment fields are ALWAYS refreshed by the update (the latch is scoped to `anulado` alone)', async () => {
    const upsertSpy = spyUpsert();

    await new PrismaFinancePaymentReceiptRepository().upsertBatch([row('R3', false)]);

    const args = upsertSpy.mock.calls[0][0] as unknown as { update: Record<string, unknown> };
    for (const field of ['clientGrId', 'recaudador', 'fechaRecibo', 'fechaConfirmacion', 'observaciones']) {
      expect(Object.prototype.hasOwnProperty.call(args.update, field)).toBe(true);
    }
  });
});

describe('PrismaFinancePaymentReceiptRepository.annulmentStateOf', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns the CURRENT anulado of the rows that already exist, in ONE query (absent id = no row yet)', async () => {
    const findManySpy = jest.spyOn(prisma.financePaymentReceipt, 'findMany').mockResolvedValue([
      { grReceiptId: 'R1', anulado: false },
      { grReceiptId: 'R2', anulado: true },
    ] as never);

    const result = await new PrismaFinancePaymentReceiptRepository().annulmentStateOf(['R1', 'R2', 'R3']);

    expect(result).toEqual(new Map([['R1', false], ['R2', true]]));
    expect(findManySpy).toHaveBeenCalledTimes(1);
    expect(findManySpy).toHaveBeenCalledWith({
      where: { grReceiptId: { in: ['R1', 'R2', 'R3'] } },
      select: { grReceiptId: true, anulado: true },
    });
  });

  it('an empty id list short-circuits without querying', async () => {
    const findManySpy = jest.spyOn(prisma.financePaymentReceipt, 'findMany').mockResolvedValue([] as never);
    expect(await new PrismaFinancePaymentReceiptRepository().annulmentStateOf([])).toEqual(new Map());
    expect(findManySpy).not.toHaveBeenCalled();
  });
});

describe('PrismaFinancePaymentReceiptRepository.existingIds', () => {
  afterEach(() => jest.restoreAllMocks());

  it('queries with grReceiptId IN [...] and returns the matched ids as a Set', async () => {
    const findManySpy = jest.spyOn(prisma.financePaymentReceipt, 'findMany').mockResolvedValue([
      { grReceiptId: 'R1' },
      { grReceiptId: 'R2' },
    ] as never);

    const result = await new PrismaFinancePaymentReceiptRepository().existingIds(['R1', 'R2', 'R3']);

    expect(result).toEqual(new Set(['R1', 'R2']));
    expect(findManySpy).toHaveBeenCalledTimes(1); // ONE query, never N
    expect(findManySpy).toHaveBeenCalledWith({
      where: { grReceiptId: { in: ['R1', 'R2', 'R3'] } },
      select: { grReceiptId: true },
    });
  });

  it('an empty id list short-circuits without querying', async () => {
    const findManySpy = jest.spyOn(prisma.financePaymentReceipt, 'findMany').mockResolvedValue([] as never);
    const result = await new PrismaFinancePaymentReceiptRepository().existingIds([]);
    expect(result).toEqual(new Set());
    expect(findManySpy).not.toHaveBeenCalled();
  });
});
