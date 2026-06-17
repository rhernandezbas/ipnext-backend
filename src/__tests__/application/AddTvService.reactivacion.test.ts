/**
 * #131 PARTE B -- AddTvService reactivacion event recording.
 *
 * BUG: reconcileTvContractService REACTIVATES an inactive TV row but records NO event.
 *      The actor is never threaded down to reconcile.
 *
 * FIX:
 *   - Thread actor (actorId/actorName) from route -> AddTvService.execute() -> reconcileTvContractService()
 *   - Pass TvActivationEventRepository (optional) to AddTvService and reconcile.
 *   - When reconcile sets an existing INACTIVE row to ACTIVE, record 'reactivacion' best-effort.
 */
import { AddTvService } from "@application/use-cases/gigared/AddTvService";
import { InMemoryContractServiceRepository } from "@infrastructure/adapters/in-memory/InMemoryContractServiceRepository";
import { InMemoryServiceCatalogRepository } from "@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository";
import { InMemoryTvActivationEventRepository } from "@infrastructure/adapters/in-memory/InMemoryTvActivationEventRepository";
import type { GigaredPort, GigaredAccount } from "@domain/ports/GigaredPort";

function fakeAccount(over: Partial<GigaredAccount> = {}): GigaredAccount {
  return {
    cic: "0000000001", gigaredId: "100", email: "e@x.com", firstName: "N", lastName: "A",
    registrationDate: "2026-01-19", services: [{ id: "129", name: "Gigared Play Full" }],
    internalId: "cust-1", clientId: "cust-1", ott: null, ...over,
  };
}

function fakePort(over: Partial<GigaredPort> = {}): GigaredPort {
  return {
    getSummary: jest.fn(), listAccounts: jest.fn(),
    getAccountByInternalId: jest.fn(async () => fakeAccount()),
    getAccountByCic: jest.fn(async () => fakeAccount()),
    register: jest.fn(), activate: jest.fn(), setInternalId: jest.fn(),
    addService: jest.fn(async () => {}),
    removeService: jest.fn(async () => {}),
    setOtt: jest.fn(async () => {}),
    changePassword: jest.fn(async () => {}),
    renewCic: jest.fn(async () => ({ oldCic: "0000000001", newCic: "0000000002" })),
    ...over,
  };
}

const lookup = (exists: boolean) => ({ findById: async (id: string) => (exists ? { id } : null) });
const contractLookup = (exists: boolean, ownerId = "cust-1") => ({ findById: async (id: string) => (exists ? { id, clientId: ownerId } : null) });

async function seedTvCatalog(catalog: InMemoryServiceCatalogRepository, cs: InMemoryContractServiceRepository, active = true) {
  const cat = await catalog.create({ name: "TV", label: "TV", active, sortOrder: 0 });
  (cs as any).catalog[cat.id] = { name: cat.name, label: cat.label };
  return cat;
}

describe("AddTvService #131 PARTE B -- reactivacion event recording", () => {
  let cs: InMemoryContractServiceRepository;
  let catalog: InMemoryServiceCatalogRepository;
  beforeEach(() => {
    cs      = new InMemoryContractServiceRepository();
    catalog = new InMemoryServiceCatalogRepository();
  });

  it("B-1: reactivar fila INACTIVA registra evento reactivacion con actor correcto", async () => {
    const cat = await seedTvCatalog(catalog, cs);
    // Pre-seed an INACTIVE TV row (the reuse scenario: was active, then cancelled, now re-alta)
    const existing = await cs.add({ contractId: "C1", serviceCatalogId: cat.id, notes: "CIC 0000000001 Gigared Play Full" });
    await cs.update(existing.id, { status: "inactive" });

    const tvEventRepo = new InMemoryTvActivationEventRepository();
    const port = fakePort({ getAccountByInternalId: jest.fn(async () => fakeAccount({ services: [{ id: "129", name: "Gigared Play Full" }] })) });

    const uc = new AddTvService(port, cs, catalog, contractLookup(true), lookup(true), tvEventRepo);
    const result = await uc.execute("cust-1", { contractId: "C1", serviceId: "129", actorId: "actor-1", actorName: "jperez" });

    expect(result.local).toBe("ok");

    // A 'reactivacion' event must have been recorded
    const events = tvEventRepo.all();
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("reactivacion");
    expect(events[0]!.actorId).toBe("actor-1");
    expect(events[0]!.actorName).toBe("jperez");
    expect(events[0]!.contractId).toBe("C1");
    expect(events[0]!.clientId).toBe("cust-1");
  });

  it("B-2: crear fila NUEVA (primera alta) NO registra reactivacion", async () => {
    await seedTvCatalog(catalog, cs);
    const tvEventRepo = new InMemoryTvActivationEventRepository();
    const port = fakePort({ getAccountByInternalId: jest.fn(async () => fakeAccount({ services: [{ id: "129", name: "Gigared Play Full" }] })) });
    const uc = new AddTvService(port, cs, catalog, contractLookup(true), lookup(true), tvEventRepo);
    const result = await uc.execute("cust-1", { contractId: "C1", serviceId: "129", actorId: "actor-1", actorName: "sys" });
    expect(result.local).toBe("ok");
    // No reactivacion event for a brand-new row (alta is handled by RegisterGigaredAccount)
    expect(tvEventRepo.all()).toHaveLength(0);
  });

  it("B-3: event recorder throws -> operacion principal no falla (best-effort)", async () => {
    const cat = await seedTvCatalog(catalog, cs);
    const existing = await cs.add({ contractId: "C1", serviceCatalogId: cat.id, notes: "CIC 0000000001 Gigared Play Full" });
    await cs.update(existing.id, { status: "inactive" });

    const throwingRepo = {
      record: jest.fn(async () => { throw new Error("event DB down"); }),
      listByClient: jest.fn(async () => []),
      list: jest.fn(async () => []),
      listByContract: jest.fn(async () => []),
    };
    const port = fakePort({ getAccountByInternalId: jest.fn(async () => fakeAccount({ services: [{ id: "129", name: "Gigared Play Full" }] })) });
    const uc = new AddTvService(port, cs, catalog, contractLookup(true), lookup(true), throwingRepo);

    // Must NOT throw -- best-effort
    const result = await uc.execute("cust-1", { contractId: "C1", serviceId: "129", actorId: "a", actorName: "op" });
    expect(result.gigared).toBe("ok");
    expect(result.local).toBe("ok");
  });

  it("B-4: sin tvEventRepo (parametro opcional) -> sin evento, sin error", async () => {
    const cat = await seedTvCatalog(catalog, cs);
    const existing = await cs.add({ contractId: "C1", serviceCatalogId: cat.id, notes: "CIC 0000000001 Gigared Play Full" });
    await cs.update(existing.id, { status: "inactive" });

    const port = fakePort({ getAccountByInternalId: jest.fn(async () => fakeAccount({ services: [{ id: "129", name: "Gigared Play Full" }] })) });
    // No tvEventRepo passed (old constructor signature, backward compat)
    const uc = new AddTvService(port, cs, catalog, contractLookup(true), lookup(true));
    const result = await uc.execute("cust-1", { contractId: "C1", serviceId: "129", actorId: "a", actorName: "op" });
    expect(result.local).toBe("ok");
  });
});
