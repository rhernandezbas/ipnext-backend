import { ComputeCacAndPayback } from '@application/use-cases/finance/ComputeCacAndPayback';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractRepository } from '@infrastructure/adapters/in-memory/InMemoryContractRepository';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryFinancePlanPriceRepository } from '@infrastructure/adapters/in-memory/InMemoryFinancePlanPriceRepository';
import { InMemoryFinanceTechnologyCostRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceTechnologyCostRepository';
import { InMemoryContractTechnologyRepository } from '@infrastructure/adapters/in-memory/InMemoryContractTechnologyRepository';
import { InMemoryFinanceTargetsConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceTargetsConfigRepository';
import { InMemoryFinancePaymentReceiptRepository } from '@infrastructure/adapters/in-memory/InMemoryFinancePaymentReceiptRepository';
import { InMemoryFinanceReceiptItemRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptItemRepository';
import { InMemoryClientMirrorReadRepository } from '@infrastructure/adapters/in-memory/InMemoryClientMirrorReadRepository';
import { FinanceTechnologyNotFoundError } from '@domain/errors/finance';
import type { ServiceCatalog } from '@domain/entities/service-catalog';

async function makeEnv() {
  const catalogRepo = new InMemoryServiceCatalogRepository();
  const internet: ServiceCatalog = await catalogRepo.create({ name: 'INTERNET' });
  const clock = { now: new Date('2026-03-15T12:00:00.000Z') };
  const eventRepo = new InMemoryContractServiceEventRepository({ now: () => clock.now });
  const contractRepo = new InMemoryContractRepository();
  const pppoeRepo = new InMemoryPppoeServiceRepository({ now: () => clock.now });
  const planPriceRepo = new InMemoryFinancePlanPriceRepository();
  const technologyCostRepo = new InMemoryFinanceTechnologyCostRepository();
  const technologyCatalogRepo = new InMemoryContractTechnologyRepository();
  await technologyCatalogRepo.create({ name: 'Fibra', description: null });
  const targetsRepo = new InMemoryFinanceTargetsConfigRepository();
  targetsRepo.seed({ churnTargetPct: 5, maxPaybackMonths: 12, monthlyNewContractsGoal: 0, inflationBaseYearMonth: '' });
  const receiptRepo = new InMemoryFinancePaymentReceiptRepository();
  const itemRepo = new InMemoryFinanceReceiptItemRepository(receiptRepo);
  const clientLinks = new InMemoryClientMirrorReadRepository();

  const useCase = new ComputeCacAndPayback(
    technologyCostRepo,
    technologyCatalogRepo,
    targetsRepo,
    eventRepo,
    catalogRepo,
    contractRepo,
    pppoeRepo,
    planPriceRepo,
    itemRepo,
    clientLinks,
  );

  function seedContract(id: string, clientId: string, technology: string | null) {
    contractRepo.seed({ id, clientId, clientName: `Cliente ${clientId}`, plan: 'IP-100', technology });
    eventRepo.setContractClient(id, clientId, `Cliente ${clientId}`);
  }
  async function activateWithPlan(contractId: string, planCode: string) {
    await eventRepo.record({ contractId, serviceCatalogId: internet.id, eventType: 'activated', actorId: null, actorName: 'sistema' });
    await pppoeRepo.upsertByUsername({ username: `pppoe-${contractId}`, password: 'x', profile: planCode, nasId: null, contractId, status: 'enabled' });
  }
  function linkClient(clientId: string, grClienteId: string) {
    clientLinks.grClienteIdByClientId.set(clientId, grClienteId);
  }
  let receiptSeq = 0;
  async function seedCash(clientGrId: string, iso: string, amount: number) {
    receiptSeq += 1;
    const grReceiptId = `receipt-${receiptSeq}`;
    await receiptRepo.upsertBatch([
      { grReceiptId, clientGrId, recaudador: null, fechaRecibo: new Date(iso), fechaConfirmacion: null, anulado: false, observaciones: null },
    ]);
    await itemRepo.upsertBatch([
      { grItemId: `${grReceiptId}-item-1`, receiptId: grReceiptId, banco: null, cajaCuentaId: null, destino: null, fecha: new Date(iso), amount, moneda: null, numeroTransferencia: null, tipo: null },
    ]);
  }
  async function definePrice(code: string, estimatedMonthlyPrice: number) {
    await planPriceRepo.upsert(code, { estimatedMonthlyPrice, updatedByUserId: null });
  }
  async function defineCost(technologyName: string, patch: { costoVentaArs: number; costoInstalacionArs: number; costoMensualServicioArs: number; comisionVentaPct: number }) {
    await technologyCostRepo.upsert(technologyName, { ...patch, updatedByUserId: null });
  }

  return {
    useCase, seedContract, activateWithPlan, linkClient, seedCash, definePrice, defineCost, clock, internet, eventRepo,
  };
}

describe('ComputeCacAndPayback (design.md HTTP Contract "GET /cac")', () => {
  it('4.8 — payback within maxPaybackMonths is NOT flagged as loss-making', async () => {
    const env = await makeEnv();
    await env.defineCost('Fibra', { costoVentaArs: 20000, costoInstalacionArs: 10000, costoMensualServicioArs: 0, comisionVentaPct: 0 }); // CAC = 30000
    await env.definePrice('IP-30', 10000); // payback = 3 months
    env.seedContract('c1', 'client-1', 'Fibra');
    await env.activateWithPlan('c1', 'IP-30');
    env.linkClient('client-1', 'GR-1');
    await env.seedCash('GR-1', '2026-03-15T12:00:00.000Z', 10000);

    const result = await env.useCase.execute('Fibra', '2026-03');

    expect(result.costConfigured).toBe(true);
    expect(result.cacArs).toBe(30000);
    const alta = result.altasDelMes.find((a) => a.contractId === 'c1')!;
    expect(alta.mrrAtribuidoArs).toBe(10000);
    expect(alta.paybackMonths).toBe(3);
    expect(alta.lossMaking).toBe(false);
  });

  it('4.9 — payback beyond maxPaybackMonths IS flagged loss-making, with paybackMonths calculated', async () => {
    const env = await makeEnv();
    await env.defineCost('Fibra', { costoVentaArs: 20000, costoInstalacionArs: 10000, costoMensualServicioArs: 0, comisionVentaPct: 0 }); // CAC = 30000
    await env.definePrice('IP-1500', 1500); // payback = 20 months
    env.seedContract('c2', 'client-2', 'Fibra');
    await env.activateWithPlan('c2', 'IP-1500');
    env.linkClient('client-2', 'GR-2');
    await env.seedCash('GR-2', '2026-03-15T12:00:00.000Z', 1500);

    const result = await env.useCase.execute('Fibra', '2026-03');

    const alta = result.altasDelMes.find((a) => a.contractId === 'c2')!;
    expect(alta.paybackMonths).toBe(20);
    expect(alta.lossMaking).toBe(true);
  });

  it('4.10 — mrrAtribuidoArs: 0 gives paybackMonths: null, never a division by zero or Infinity', async () => {
    const env = await makeEnv();
    await env.defineCost('Fibra', { costoVentaArs: 20000, costoInstalacionArs: 10000, costoMensualServicioArs: 0, comisionVentaPct: 0 });
    await env.definePrice('IP-30', 10000);
    env.seedContract('c3', 'client-3', 'Fibra');
    await env.activateWithPlan('c3', 'IP-30');
    // Deliberately NO linkClient/seedCash — this client collected nothing this month.

    const result = await env.useCase.execute('Fibra', '2026-03');

    const alta = result.altasDelMes.find((a) => a.contractId === 'c3')!;
    expect(alta.mrrAtribuidoArs).toBe(0);
    expect(alta.paybackMonths).toBeNull();
    expect(alta.lossMaking).toBe(false);
    expect(Number.isFinite(alta.paybackMonths as unknown as number)).toBe(false); // it's null, not Infinity/NaN
  });

  it('THE TRAP — an unconfigured technology cost gives cacArs: null and costConfigured: false, NEVER cacArs: 0 / lossMaking: false for everyone', async () => {
    const env = await makeEnv();
    // Deliberately never call defineCost('Fibra', ...) — no row exists at all.
    await env.definePrice('IP-30', 10000);
    env.seedContract('c4', 'client-4', 'Fibra');
    await env.activateWithPlan('c4', 'IP-30');
    env.linkClient('client-4', 'GR-4');
    await env.seedCash('GR-4', '2026-03-15T12:00:00.000Z', 10000);

    const result = await env.useCase.execute('Fibra', '2026-03');

    expect(result.costConfigured).toBe(false);
    expect(result.costoVentaArs).toBeNull();
    expect(result.costoInstalacionArs).toBeNull();
    expect(result.cacArs).toBeNull();
    const alta = result.altasDelMes.find((a) => a.contractId === 'c4')!;
    // mrrAtribuidoArs is real (10000, cash was collected) — but payback cannot
    // be computed without a CAC, so it must be null, NOT a payback against a
    // phantom CAC of 0 (which would read as "instant payback", the exact
    // opposite lie of what "not configured" means).
    expect(alta.paybackMonths).toBeNull();
    expect(alta.lossMaking).toBe(false);
  });

  it('404s for a technology absent from the ContractTechnology catalog', async () => {
    const env = await makeEnv();
    await expect(env.useCase.execute('Fibrra', '2026-03')).rejects.toBeInstanceOf(FinanceTechnologyNotFoundError);
  });

  it('a single-contract client gets "exact" attribution confidence', async () => {
    const env = await makeEnv();
    await env.defineCost('Fibra', { costoVentaArs: 10000, costoInstalacionArs: 0, costoMensualServicioArs: 0, comisionVentaPct: 0 });
    await env.definePrice('IP-30', 10000);
    env.seedContract('c5', 'client-5', 'Fibra');
    await env.activateWithPlan('c5', 'IP-30');
    env.linkClient('client-5', 'GR-5');
    await env.seedCash('GR-5', '2026-03-15T12:00:00.000Z', 10000);

    const result = await env.useCase.execute('Fibra', '2026-03');

    expect(result.altasDelMes.find((a) => a.contractId === 'c5')!.attributionConfidence).toBe('exact');
  });

  it('an alta belonging to a DIFFERENT technology never appears in the listing', async () => {
    const env = await makeEnv();
    await env.defineCost('Fibra', { costoVentaArs: 10000, costoInstalacionArs: 0, costoMensualServicioArs: 0, comisionVentaPct: 0 });
    await env.definePrice('IP-30', 10000);
    env.seedContract('wireless-contract', 'client-6', 'Wireless');
    await env.activateWithPlan('wireless-contract', 'IP-30');

    const result = await env.useCase.execute('Fibra', '2026-03');

    expect(result.altasDelMes.find((a) => a.contractId === 'wireless-contract')).toBeUndefined();
  });

  it('fix-wave-4 🔴2 — 5 real altas with technology:null (the majority-case shape of a GR-derived contract) never silently read as "0 ventas": altasDelMesSinTecnologia surfaces the count', async () => {
    const env = await makeEnv();
    await env.defineCost('Fibra', { costoVentaArs: 20000, costoInstalacionArs: 10000, costoMensualServicioArs: 0, comisionVentaPct: 0 });
    await env.definePrice('IP-30', 10000);
    for (let i = 0; i < 5; i++) {
      const id = `untagged-${i}`;
      env.seedContract(id, `client-untagged-${i}`, null); // Contract.technology === null — the GR-derived norm.
      await env.activateWithPlan(id, 'IP-30');
      env.linkClient(`client-untagged-${i}`, `GR-untagged-${i}`);
      await env.seedCash(`GR-untagged-${i}`, '2026-03-15T12:00:00.000Z', 10000);
    }

    const result = await env.useCase.execute('Fibra', '2026-03');

    // The old lie: cacArs is a real, configured number, altasDelMes is [] —
    // reads as "CAC $30.000, cero ventas este mes" when the truth is "5
    // ventas reales que no puedo clasificar por tecnología".
    expect(result.costConfigured).toBe(true);
    expect(result.altasDelMes).toEqual([]);
    expect(result.altasDelMesSinTecnologia).toBe(5);
  });

  it('altasDelMesSinTecnologia counts ONLY null-technology altas, never altas correctly classified under a DIFFERENT technology', async () => {
    const env = await makeEnv();
    await env.defineCost('Fibra', { costoVentaArs: 10000, costoInstalacionArs: 0, costoMensualServicioArs: 0, comisionVentaPct: 0 });
    await env.definePrice('IP-30', 10000);
    env.seedContract('wireless-contract', 'client-w', 'Wireless'); // classified, just not THIS technology.
    await env.activateWithPlan('wireless-contract', 'IP-30');
    env.seedContract('untagged-contract', 'client-u', null);
    await env.activateWithPlan('untagged-contract', 'IP-30');

    const result = await env.useCase.execute('Fibra', '2026-03');

    expect(result.altasDelMesSinTecnologia).toBe(1); // only "untagged-contract", NOT "wireless-contract"
  });

  it('fix-wave-4 🟡7 — a configured row whose costs are literally 0 (the schema default, e.g. a row created but never actually filled in) is flagged via costIsZero, distinguishing it from a genuinely-priced-at-zero technology', async () => {
    const env = await makeEnv();
    // A row DOES exist (costConfigured: true) but every cost column is the
    // schema's own @default(0) — e.g. an operator created the row and never
    // filled it in. Before this fix, `costConfigured: true` alone told the FE
    // "trust cacArs: 0" with zero way to tell this apart from a REAL free
    // technology.
    await env.defineCost('Fibra', { costoVentaArs: 0, costoInstalacionArs: 0, costoMensualServicioArs: 0, comisionVentaPct: 0 });

    const result = await env.useCase.execute('Fibra', '2026-03');

    expect(result.costConfigured).toBe(true);
    expect(result.cacArs).toBe(0);
    expect(result.costIsZero).toBe(true);
  });

  it('a genuinely non-zero configured cost has costIsZero: false', async () => {
    const env = await makeEnv();
    await env.defineCost('Fibra', { costoVentaArs: 20000, costoInstalacionArs: 10000, costoMensualServicioArs: 0, comisionVentaPct: 0 });

    const result = await env.useCase.execute('Fibra', '2026-03');

    expect(result.costIsZero).toBe(false);
  });

  it('costIsZero is false (not true) when the technology cost is NOT configured at all — that case is already covered by costConfigured:false', async () => {
    const env = await makeEnv();
    // Deliberately never call defineCost.

    const result = await env.useCase.execute('Fibra', '2026-03');

    expect(result.costConfigured).toBe(false);
    expect(result.costIsZero).toBe(false);
  });

  it('fix-wave-4 🟡6 — the technology filter is case-INSENSITIVE, matching the catalog\'s own case-insensitive resolution: "fibra" on a contract must count as "Fibra"', async () => {
    const env = await makeEnv();
    await env.defineCost('Fibra', { costoVentaArs: 20000, costoInstalacionArs: 10000, costoMensualServicioArs: 0, comisionVentaPct: 0 });
    await env.definePrice('IP-30', 10000);
    env.seedContract('lowercase-tech', 'client-lc', 'fibra'); // lowercase on the Contract row, catalog canonical is "Fibra".
    await env.activateWithPlan('lowercase-tech', 'IP-30');
    env.linkClient('client-lc', 'GR-lc');
    await env.seedCash('GR-lc', '2026-03-15T12:00:00.000Z', 10000);

    const result = await env.useCase.execute('Fibra', '2026-03');

    expect(result.altasDelMes.find((a) => a.contractId === 'lowercase-tech')).toBeDefined();
    expect(result.altasDelMesSinTecnologia).toBe(0);
  });
});
