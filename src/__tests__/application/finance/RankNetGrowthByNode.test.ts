import { RankNetGrowthByNode } from '@application/use-cases/finance/RankNetGrowthByNode';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractRepository } from '@infrastructure/adapters/in-memory/InMemoryContractRepository';
import type { ServiceCatalog } from '@domain/entities/service-catalog';

async function makeEnv() {
  const catalogRepo = new InMemoryServiceCatalogRepository();
  const internet: ServiceCatalog = await catalogRepo.create({ name: 'INTERNET' });
  const clock = { now: new Date('2026-03-01T12:00:00.000Z') };
  const eventRepo = new InMemoryContractServiceEventRepository({ now: () => clock.now });
  const contractRepo = new InMemoryContractRepository();
  const useCase = new RankNetGrowthByNode(eventRepo, catalogRepo, contractRepo);

  function seedContract(id: string, clientName: string, networkSiteId: string | null, networkSiteName: string | null) {
    contractRepo.seed({ id, clientId: id, clientName, plan: 'IP-100', networkSiteId, networkSiteName });
    eventRepo.setContractClient(id, id, clientName);
  }
  async function activate(contractId: string) {
    await eventRepo.record({ contractId, serviceCatalogId: internet.id, eventType: 'activated', actorId: null, actorName: 'sistema' });
  }
  async function reactivate(contractId: string) {
    await eventRepo.record({ contractId, serviceCatalogId: internet.id, eventType: 'reactivated', actorId: null, actorName: 'sistema' });
  }
  async function deactivate(contractId: string) {
    await eventRepo.record({ contractId, serviceCatalogId: internet.id, eventType: 'deactivated', actorId: null, actorName: 'sistema' });
  }

  return { eventRepo, contractRepo, useCase, seedContract, activate, reactivate, deactivate, clock };
}

describe('RankNetGrowthByNode (design.md HTTP Contract "GET /nodes/growth")', () => {
  it('4.15 — a node with 2 altas and 8 bajas shows netGrowth: -6', async () => {
    const env = await makeEnv();
    for (let i = 0; i < 2; i++) {
      const id = `alta-${i}`;
      env.seedContract(id, `Cliente ${id}`, 'node-1', 'Nodo Centro');
      await env.activate(id);
    }
    for (let i = 0; i < 8; i++) {
      const id = `baja-${i}`;
      env.seedContract(id, `Cliente ${id}`, 'node-1', 'Nodo Centro');
      await env.deactivate(id);
    }

    const result = await env.useCase.execute('2026-03', '2026-03');

    expect(result.nodes).toEqual([{ networkSiteId: 'node-1', networkSiteName: 'Nodo Centro', altas: 2, bajas: 8, netGrowth: -6 }]);
  });

  it('contracts with no node assignment group under networkSiteId: null, never dropped', async () => {
    const env = await makeEnv();
    env.seedContract('c1', 'Cliente 1', null, null);
    await env.activate('c1');

    const result = await env.useCase.execute('2026-03', '2026-03');

    expect(result.nodes).toEqual([{ networkSiteId: null, networkSiteName: null, altas: 1, bajas: 0, netGrowth: 1 }]);
  });

  it('sorts ASC by netGrowth — the most negative (needs attention) node comes first', async () => {
    const env = await makeEnv();
    env.seedContract('healthy', 'Cliente Sano', 'node-healthy', 'Nodo Sano');
    await env.activate('healthy');
    await env.activate('healthy2');
    env.seedContract('healthy2', 'Cliente Sano 2', 'node-healthy', 'Nodo Sano');

    env.seedContract('sick', 'Cliente Enfermo', 'node-sick', 'Nodo Enfermo');
    await env.deactivate('sick');

    const result = await env.useCase.execute('2026-03', '2026-03');

    expect(result.nodes[0].networkSiteId).toBe('node-sick');
    expect(result.nodes[0].netGrowth).toBeLessThan(result.nodes[result.nodes.length - 1].netGrowth);
  });

  it('fix-wave-4 🟡8 — a contract with BOTH an "activated" and a "reactivated" event in-range counts as ONE alta, never two (same dedup criterion as ComputeCacAndPayback/RankEarlyChurnByVendor)', async () => {
    const env = await makeEnv();
    env.seedContract('flappy', 'Cliente Flappy', 'node-1', 'Nodo Centro');
    await env.activate('flappy');
    await env.deactivate('flappy');
    await env.reactivate('flappy');

    const result = await env.useCase.execute('2026-03', '2026-03');

    const node = result.nodes.find((n) => n.networkSiteId === 'node-1')!;
    // 1 alta (deduped), 1 baja, netGrowth = 1 - 1 = 0 — NOT 2 altas.
    expect(node.altas).toBe(1);
    expect(node.bajas).toBe(1);
    expect(node.netGrowth).toBe(0);
  });

  it('fix-wave-4 🔵16 — a tie in netGrowth breaks deterministically by networkSiteId ASC, never by Map iteration order', async () => {
    const env = await makeEnv();
    env.seedContract('z1', 'Cliente Z', 'node-zzz', 'Nodo Z');
    await env.activate('z1');
    env.seedContract('a1', 'Cliente A', 'node-aaa', 'Nodo A');
    await env.activate('a1');

    const result = await env.useCase.execute('2026-03', '2026-03');

    // Both nodes have netGrowth: 1 (tied) — "node-aaa" must sort BEFORE "node-zzz" deterministically.
    expect(result.nodes.map((n) => n.networkSiteId)).toEqual(['node-aaa', 'node-zzz']);
  });

  it('rejects malformed range params', async () => {
    const env = await makeEnv();
    await expect(env.useCase.execute('2026-1', '2026-03')).rejects.toThrow();
  });

  it('fix-wave-4 🔵17 — rejects a range wider than 240 months', async () => {
    const env = await makeEnv();
    await expect(env.useCase.execute('1990-01', '2026-12')).rejects.toThrow();
  });
});
