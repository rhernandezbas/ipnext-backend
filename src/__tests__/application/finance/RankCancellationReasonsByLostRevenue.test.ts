import { RankCancellationReasonsByLostRevenue } from '@application/use-cases/finance/RankCancellationReasonsByLostRevenue';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractRepository } from '@infrastructure/adapters/in-memory/InMemoryContractRepository';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryFinancePlanPriceRepository } from '@infrastructure/adapters/in-memory/InMemoryFinancePlanPriceRepository';
import type { ServiceCatalog } from '@domain/entities/service-catalog';

async function makeEnv() {
  const catalogRepo = new InMemoryServiceCatalogRepository();
  const internet: ServiceCatalog = await catalogRepo.create({ name: 'INTERNET' });
  const clock = { now: new Date('2026-03-15T12:00:00.000Z') };
  const eventRepo = new InMemoryContractServiceEventRepository({ now: () => clock.now });
  const contractRepo = new InMemoryContractRepository();
  const pppoeRepo = new InMemoryPppoeServiceRepository({ now: () => clock.now });
  const planPriceRepo = new InMemoryFinancePlanPriceRepository();
  const useCase = new RankCancellationReasonsByLostRevenue(eventRepo, catalogRepo, contractRepo, pppoeRepo, planPriceRepo);

  function seedContract(id: string, motivoBaja: string | null) {
    contractRepo.seed({ id, clientId: id, clientName: `Cliente ${id}`, plan: 'IP-100', motivoBaja });
    eventRepo.setContractClient(id, id, `Cliente ${id}`);
  }
  async function activateWithPlan(contractId: string, planCode: string) {
    await eventRepo.record({ contractId, serviceCatalogId: internet.id, eventType: 'activated', actorId: null, actorName: 'sistema' });
    await pppoeRepo.upsertByUsername({ username: `pppoe-${contractId}`, password: 'x', profile: planCode, nasId: null, contractId, status: 'enabled' });
  }
  async function deactivate(contractId: string, reason?: string | null) {
    await eventRepo.record({ contractId, serviceCatalogId: internet.id, eventType: 'deactivated', actorId: null, actorName: 'sistema', reason: reason ?? null });
  }
  async function definePrice(code: string, estimatedMonthlyPrice: number) {
    await planPriceRepo.upsert(code, { estimatedMonthlyPrice, updatedByUserId: null });
  }

  return { eventRepo, contractRepo, pppoeRepo, planPriceRepo, useCase, seedContract, activateWithPlan, deactivate, definePrice, clock, internet };
}

describe('RankCancellationReasonsByLostRevenue (design.md HTTP Contract "GET /motivos-baja")', () => {
  it('4.17 — a less-frequent, higher-value reason ("mudanza") outranks a more-frequent, lower-value one ("precio")', async () => {
    const env = await makeEnv();
    await env.definePrice('IP-5000', 5000);
    await env.definePrice('IP-2000', 2000);

    for (let i = 0; i < 10; i++) {
      const id = `mudanza-${i}`;
      env.seedContract(id, 'mudanza');
      await env.activateWithPlan(id, 'IP-5000');
      await env.deactivate(id);
    }
    for (let i = 0; i < 15; i++) {
      const id = `precio-${i}`;
      env.seedContract(id, 'precio');
      await env.activateWithPlan(id, 'IP-2000');
      await env.deactivate(id);
    }

    const result = await env.useCase.execute('2026-03', '2026-03');

    const mudanza = result.motivos.find((m) => m.motivo === 'mudanza')!;
    const precio = result.motivos.find((m) => m.motivo === 'precio')!;
    expect(mudanza.bajas).toBe(10);
    expect(mudanza.mrrPerdidoArs).toBe(50000);
    expect(precio.bajas).toBe(15);
    expect(precio.mrrPerdidoArs).toBe(30000);
    // mudanza has FEWER bajas but ranks FIRST because it lost more money.
    expect(result.motivos[0].motivo).toBe('mudanza');
  });

  it('4.18 — Contract.motivoBaja null falls back to ContractServiceEvent.reason; both null groups under "sin especificar"', async () => {
    const env = await makeEnv();
    await env.definePrice('IP-1000', 1000);

    env.seedContract('event-reason', null);
    await env.activateWithPlan('event-reason', 'IP-1000');
    await env.deactivate('event-reason', 'no pagó');

    env.seedContract('no-reason-at-all', null);
    await env.activateWithPlan('no-reason-at-all', 'IP-1000');
    await env.deactivate('no-reason-at-all', null);

    const result = await env.useCase.execute('2026-03', '2026-03');

    const eventReasonRow = result.motivos.find((m) => m.motivo === 'no pagó');
    const unspecifiedRow = result.motivos.find((m) => m.motivo === 'sin especificar');
    expect(eventReasonRow).toBeDefined();
    expect(unspecifiedRow).toBeDefined();
    expect(unspecifiedRow!.bajas).toBe(1);
  });

  it('a baja with an unresolvable price contributes 0 to mrrPerdidoArs, never a guess, and is still counted, with bajasSinPrecio: 1', async () => {
    const env = await makeEnv();
    // No PppoeService seeded at all (never call activateWithPlan) — the plan is unresolvable.
    env.seedContract('unpriced', 'sin servicio');
    await env.eventRepo.record({ contractId: 'unpriced', serviceCatalogId: env.internet.id, eventType: 'activated', actorId: null, actorName: 'sistema' });
    await env.deactivate('unpriced');

    const result = await env.useCase.execute('2026-03', '2026-03');

    const row = result.motivos.find((m) => m.motivo === 'sin servicio');
    expect(row).toEqual({ motivo: 'sin servicio', bajas: 1, mrrPerdidoArs: 0, bajasSinPrecio: 1 });
  });

  it('fix-wave-4 🔴3 — FinancePlanPrice completely EMPTY (the measured prod state: 387/387 contratos sin precio) never silently collapses the ranking to $0-across-the-board with zero signal', async () => {
    const env = await makeEnv();
    // Deliberately NEVER call env.definePrice — FinancePlanPrice stays empty,
    // reproducing the measured prod state.
    for (let i = 0; i < 3; i++) {
      const id = `precio-${i}`;
      env.seedContract(id, 'Precio');
      await env.activateWithPlan(id, 'IP-2000'); // resolves to a plan, but NO price row exists for it
      await env.deactivate(id);
    }
    for (let i = 0; i < 10; i++) {
      const id = `mudanza-${i}`;
      env.seedContract(id, 'Mudanza');
      await env.activateWithPlan(id, 'IP-5000');
      await env.deactivate(id);
    }

    const result = await env.useCase.execute('2026-03', '2026-03');

    const precio = result.motivos.find((m) => m.motivo === 'Precio')!;
    const mudanza = result.motivos.find((m) => m.motivo === 'Mudanza')!;
    // The old lie: both rows silently read mrrPerdidoArs: 0 with NO signal that
    // the ranking's entire reason for existing (money, not count) is dead.
    expect(precio.mrrPerdidoArs).toBe(0);
    expect(mudanza.mrrPerdidoArs).toBe(0);
    // The fix: every baja in both buckets is flagged as unpriced.
    expect(precio.bajasSinPrecio).toBe(3);
    expect(mudanza.bajasSinPrecio).toBe(10);
  });

  it('bajasSinPrecio counts ONLY the unpriced bajas within a motivo, never the priced ones in the same bucket', async () => {
    const env = await makeEnv();
    await env.definePrice('IP-5000', 5000);
    env.seedContract('priced', 'mudanza');
    await env.activateWithPlan('priced', 'IP-5000');
    await env.deactivate('priced');
    env.seedContract('unpriced', 'mudanza');
    await env.activateWithPlan('unpriced', 'IP-9999'); // never priced
    await env.deactivate('unpriced');

    const result = await env.useCase.execute('2026-03', '2026-03');

    const mudanza = result.motivos.find((m) => m.motivo === 'mudanza')!;
    expect(mudanza.bajas).toBe(2);
    expect(mudanza.bajasSinPrecio).toBe(1);
    expect(mudanza.mrrPerdidoArs).toBe(5000);
  });

  it('fix-wave-4 🟡10 — "Contrato"/"  Contrato  " and "Precio"/"precio" group under ONE row, never split by whitespace or casing', async () => {
    const env = await makeEnv();
    await env.definePrice('IP-1000', 1000);
    env.seedContract('c1', 'Contrato');
    await env.activateWithPlan('c1', 'IP-1000');
    await env.deactivate('c1');
    env.seedContract('c2', '  Contrato  ');
    await env.activateWithPlan('c2', 'IP-1000');
    await env.deactivate('c2');
    env.seedContract('c3', 'precio');
    await env.activateWithPlan('c3', 'IP-1000');
    await env.deactivate('c3');
    env.seedContract('c4', 'Precio');
    await env.activateWithPlan('c4', 'IP-1000');
    await env.deactivate('c4');

    const result = await env.useCase.execute('2026-03', '2026-03');

    const contratoRows = result.motivos.filter((m) => m.motivo.trim().toLowerCase() === 'contrato');
    const precioRows = result.motivos.filter((m) => m.motivo.trim().toLowerCase() === 'precio');
    expect(contratoRows).toHaveLength(1);
    expect(contratoRows[0].bajas).toBe(2);
    expect(precioRows).toHaveLength(1);
    expect(precioRows[0].bajas).toBe(2);
  });

  it('fix-wave-4 🔵16 — a tie in mrrPerdidoArs breaks deterministically by motivo ASC, never by Map iteration order', async () => {
    const env = await makeEnv();
    await env.definePrice('IP-1000', 1000);
    env.seedContract('z1', 'Zeta');
    await env.activateWithPlan('z1', 'IP-1000');
    await env.deactivate('z1');
    env.seedContract('a1', 'Alfa');
    await env.activateWithPlan('a1', 'IP-1000');
    await env.deactivate('a1');

    const result = await env.useCase.execute('2026-03', '2026-03');

    // Both motivos lose the same $1000 (tied) — "Alfa" must sort BEFORE "Zeta" deterministically.
    expect(result.motivos.map((m) => m.motivo)).toEqual(['Alfa', 'Zeta']);
  });

  it('rejects malformed range params', async () => {
    const env = await makeEnv();
    await expect(env.useCase.execute('2026-03', '2026-01')).rejects.toThrow();
  });

  it('fix-wave-4 🔵17 — rejects a range wider than 240 months', async () => {
    const env = await makeEnv();
    await expect(env.useCase.execute('1990-01', '2026-12')).rejects.toThrow();
  });
});
