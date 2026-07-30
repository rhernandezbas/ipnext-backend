/**
 * gigared-tv-cic-reuse (T2.2) — contrato del puerto `TvCicReuseEligibilityRepository`
 * ejercitado sobre el adapter in-memory.
 *
 * La invariante de reutilización son TRES condiciones, y las tres son obligatorias:
 *   1. el cliente EXISTE en el mirror local
 *   2. tiene `tvCancelledAt` seteado (baja de TV local — el severing del #72)
 *   3. NO tiene ninguna fila de ContractService de TV ACTIVA
 *
 * La condición 3 es defensiva: `CancelTv` mueve el flag y la fila juntos, pero el caso
 * ALVEZ SUSANA (2026-07-30) probó que el drift EXISTE. Un cliente con el flag puesto y una
 * fila de TV viva es un estado inconsistente, y reutilizar su CIC dejaría a esa fila
 * apuntando a una cuenta que ahora es de otro.
 */
import { InMemoryTvCicReuseEligibilityRepository } from '@infrastructure/adapters/in-memory/InMemoryTvCicReuseEligibilityRepository';

const GUILLEN = 'bb25d17b-4770-48e3-9686-d9d9929e1898';
const ALVEZ = '3ef5eb6e-bc75-41a5-b816-8336c739497b';
const MALLORQUIN = '7d4e3ec6-34b0-440c-b7c2-6f263f3e6f8f';

describe('gigared-tv-cic-reuse T2.2 — InMemoryTvCicReuseEligibilityRepository', () => {
  let repo: InMemoryTvCicReuseEligibilityRepository;

  beforeEach(() => {
    repo = new InMemoryTvCicReuseEligibilityRepository();
    // Fixture NO degenerado: varios clientes en estados distintos conviviendo, para que un
    // mutante que ignore el clientId (y devuelva siempre lo mismo) NO pueda sobrevivir.
    repo.seed(GUILLEN, { cancelled: true, hasActiveTvRow: false }); // elegible
    repo.seed(MALLORQUIN, { cancelled: true, hasActiveTvRow: false }); // elegible
    repo.seed(ALVEZ, { cancelled: false, hasActiveTvRow: false }); // NO: sin baja local
  });

  it('cliente inexistente → false (condición 1)', async () => {
    await expect(repo.isEligibleForCicReuse('00000000-0000-0000-0000-000000000000')).resolves.toBe(
      false,
    );
  });

  it('cliente SIN tvCancelledAt → false (condición 2) — el caso ALVEZ SUSANA', async () => {
    await expect(repo.isEligibleForCicReuse(ALVEZ)).resolves.toBe(false);
  });

  it('cliente con tvCancelledAt Y una fila de TV ACTIVA → false (condición 3, drift)', async () => {
    repo.seed(GUILLEN, { cancelled: true, hasActiveTvRow: true });
    await expect(repo.isEligibleForCicReuse(GUILLEN)).resolves.toBe(false);
  });

  it('cliente con tvCancelledAt y SIN fila de TV activa → true (las 3 se cumplen)', async () => {
    await expect(repo.isEligibleForCicReuse(GUILLEN)).resolves.toBe(true);
    await expect(repo.isEligibleForCicReuse(MALLORQUIN)).resolves.toBe(true);
  });

  it('discrimina POR clientId — no devuelve el mismo veredicto para todos', async () => {
    const veredictos = await Promise.all(
      [GUILLEN, ALVEZ, MALLORQUIN].map(id => repo.isEligibleForCicReuse(id)),
    );
    expect(veredictos).toEqual([true, false, true]);
  });
});
