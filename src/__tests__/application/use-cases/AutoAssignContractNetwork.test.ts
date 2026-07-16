/**
 * AutoAssignContractNetwork — matriz completa design §6 (AA-1..AA-4), desempate §6.2,
 * cascada de MAC §4 (CAS-2), idempotencia y persistencia de SyncState (§7).
 *
 * Todo en memoria — jamás mockear Prisma. Semántica AUTO DURA: deriva ⇒ escribe (pisa
 * cualquier asignación previa); NO deriva ⇒ NO toca; ambiguo ⇒ skip + log.
 */
import { AutoAssignContractNetwork } from '@application/use-cases/AutoAssignContractNetwork';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRadiusEventRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusEventRepository';
import { InMemoryUispDeviceRepository } from '@infrastructure/adapters/in-memory/InMemoryUispDeviceRepository';
import { InMemoryAccessPointRepository } from '@infrastructure/adapters/in-memory/InMemoryAccessPointRepository';
import { InMemoryContractRepository } from '@infrastructure/adapters/in-memory/InMemoryContractRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import type { UispDevice } from '@domain/entities/uisp';
import type { PppoeService } from '@domain/entities/pppoeService';
import type { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';

function makeStation(overrides: Partial<UispDevice> & { uispId: string; mac: string }): UispDevice {
  const now = new Date('2026-07-01T00:00:00Z');
  return {
    id: '',
    uispSiteId: 'site-x',
    name: `Station ${overrides.uispId}`,
    model: 'M',
    modelName: null,
    type: null,
    role: 'station',
    ip: null,
    firmware: null,
    status: 'active',
    signal: null,
    uptime: null,
    lastSeenAt: null,
    missingSince: null,
    apUispDeviceId: null,
    lastSyncAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeHarness() {
  // Incrementing clock so upsertByUsername assigns strictly increasing createdAt per call
  // (row 7 — "N pppoe -> gana el enabled más reciente" needs distinguishable timestamps).
  let clock = new Date('2026-01-01T00:00:00Z').getTime();
  const pppoeRepo = new InMemoryPppoeServiceRepository({ now: () => new Date(clock++) });
  const radiusEventRepo = new InMemoryRadiusEventRepository();
  const uispDeviceRepo = new InMemoryUispDeviceRepository();
  const accessPointRepo = new InMemoryAccessPointRepository();
  const contractRepo = new InMemoryContractRepository();
  const syncStateRepo = new InMemorySyncStateRepository();
  const uc = new AutoAssignContractNetwork(
    pppoeRepo,
    radiusEventRepo,
    uispDeviceRepo,
    accessPointRepo,
    contractRepo,
    syncStateRepo,
  );
  return { pppoeRepo, radiusEventRepo, uispDeviceRepo, accessPointRepo, contractRepo, syncStateRepo, uc };
}

async function addPppoe(
  pppoeRepo: InMemoryPppoeServiceRepository,
  opts: { username: string; contractId: string | null; status?: string; callerId?: string | null },
): Promise<void> {
  const created = await pppoeRepo.upsertByUsername({
    username: opts.username,
    password: 'x',
    nasId: 'nas-1',
    contractId: opts.contractId,
    status: opts.status ?? 'enabled',
  });
  if (opts.callerId) await pppoeRepo.setCallerId(created.id, opts.callerId);
}

describe('AutoAssignContractNetwork — matriz design §6', () => {
  it('fila 1 — asigna un contrato virgen (sin asignación previa)', async () => {
    const { pppoeRepo, uispDeviceRepo, accessPointRepo, contractRepo, uc } = makeHarness();
    const c1 = contractRepo.seed({ clientName: 'Cliente 1', plan: 'Plan A' });
    await addPppoe(pppoeRepo, { username: 'user1', contractId: c1.id, callerId: 'AA:BB:CC:DD:EE:01' });
    await uispDeviceRepo.upsert(makeStation({ uispId: 'st-1', mac: 'aabbccddee01', apUispDeviceId: 'apdev-1' }));
    const ap1 = await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'apdev-1', networkSiteId: 'ns-1', name: 'AP1', mac: null });

    const result = await uc.execute();

    expect(result.assigned).toBe(1);
    expect(result.unresolved).toBe(0);
    const [assignment] = await contractRepo.getNetworkAssignments([c1.id]);
    expect(assignment).toEqual({ id: c1.id, networkSiteId: 'ns-1', accessPointId: ap1.id });
  });

  it('fila 2 — pisa una asignación manual previa distinta (AUTO DURA)', async () => {
    const { pppoeRepo, uispDeviceRepo, accessPointRepo, contractRepo, uc } = makeHarness();
    const c2 = contractRepo.seed({ clientName: 'Cliente 2', plan: 'Plan A', networkSiteId: 'ns-9', accessPointId: 'ap-9-manual' });
    await addPppoe(pppoeRepo, { username: 'user2', contractId: c2.id, callerId: 'AA:BB:CC:DD:EE:02' });
    await uispDeviceRepo.upsert(makeStation({ uispId: 'st-2', mac: 'aabbccddee02', apUispDeviceId: 'apdev-2' }));
    const ap2 = await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'apdev-2', networkSiteId: 'ns-1', name: 'AP2', mac: null });

    const result = await uc.execute();

    expect(result.assigned).toBe(1);
    const [assignment] = await contractRepo.getNetworkAssignments([c2.id]);
    expect(assignment).toEqual({ id: c2.id, networkSiteId: 'ns-1', accessPointId: ap2.id });
  });

  it('fila 3 — deriva OK pero igual a lo persistido → unchanged, sin write', async () => {
    const { pppoeRepo, uispDeviceRepo, accessPointRepo, contractRepo, uc } = makeHarness();
    await uispDeviceRepo.upsert(makeStation({ uispId: 'st-3', mac: 'aabbccddee03', apUispDeviceId: 'apdev-3' }));
    const ap3 = await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'apdev-3', networkSiteId: 'ns-3', name: 'AP3', mac: null });
    const c3 = contractRepo.seed({ clientName: 'Cliente 3', plan: 'Plan A', networkSiteId: 'ns-3', accessPointId: ap3.id });
    await addPppoe(pppoeRepo, { username: 'user3', contractId: c3.id, callerId: 'AA:BB:CC:DD:EE:03' });

    const updateSpy = jest.spyOn(contractRepo, 'updateNetworkAssignment');
    const result = await uc.execute();

    expect(result.unchanged).toBe(1);
    expect(result.assigned).toBe(0);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('fila 4 — sin match de MAC → NO toca lo existente, unresolved++', async () => {
    const { pppoeRepo, contractRepo, uc } = makeHarness();
    const c4 = contractRepo.seed({ clientName: 'Cliente 4', plan: 'Plan A', networkSiteId: 'ns-9', accessPointId: 'ap-9-manual' });
    await addPppoe(pppoeRepo, { username: 'user4', contractId: c4.id, callerId: 'AA:BB:CC:DD:EE:99' }); // no matching station

    const result = await uc.execute();

    expect(result.unresolved).toBe(1);
    expect(result.assigned).toBe(0);
    const [assignment] = await contractRepo.getNetworkAssignments([c4.id]);
    expect(assignment).toEqual({ id: c4.id, networkSiteId: 'ns-9', accessPointId: 'ap-9-manual' });
  });

  it('fila 6 — pppoe sin contractId queda fuera del universo', async () => {
    const { pppoeRepo, uc } = makeHarness();
    await addPppoe(pppoeRepo, { username: 'orphan', contractId: null, callerId: 'AA:BB:CC:DD:EE:06' });

    const result = await uc.execute();

    expect(result.contractsEvaluated).toBe(0);
    expect(result.assigned).toBe(0);
    expect(result.unresolved).toBe(0);
  });

  it('fila 7 — con N pppoe, se evalúa SOLO el enabled de createdAt más reciente', async () => {
    const { pppoeRepo, uispDeviceRepo, accessPointRepo, contractRepo, uc } = makeHarness();
    const c7 = contractRepo.seed({ clientName: 'Cliente 7', plan: 'Plan A' });
    await addPppoe(pppoeRepo, { username: 'user7-old', contractId: c7.id, callerId: 'AA:BB:CC:DD:EE:07' });
    await addPppoe(pppoeRepo, { username: 'user7-new', contractId: c7.id, callerId: 'AA:BB:CC:DD:EE:08' });

    await uispDeviceRepo.upsert(makeStation({ uispId: 'st-7old', mac: 'aabbccddee07', apUispDeviceId: 'apdev-7old' }));
    await uispDeviceRepo.upsert(makeStation({ uispId: 'st-7new', mac: 'aabbccddee08', apUispDeviceId: 'apdev-7new' }));
    await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'apdev-7old', networkSiteId: 'ns-old', name: 'AP old', mac: null });
    const apNew = await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'apdev-7new', networkSiteId: 'ns-new', name: 'AP new', mac: null });

    await uc.execute();

    const [assignment] = await contractRepo.getNetworkAssignments([c7.id]);
    expect(assignment).toEqual({ id: c7.id, networkSiteId: 'ns-new', accessPointId: apNew.id });
  });

  it('fila 8 — con 0 pppoe enabled (solo disabled) → unresolved, no se toca', async () => {
    const { pppoeRepo, contractRepo, uc } = makeHarness();
    const c8 = contractRepo.seed({ clientName: 'Cliente 8', plan: 'Plan A', networkSiteId: 'ns-9', accessPointId: 'ap-9-manual' });
    await addPppoe(pppoeRepo, { username: 'user8', contractId: c8.id, status: 'disabled', callerId: 'AA:BB:CC:DD:EE:08' });

    const result = await uc.execute();

    expect(result.unresolved).toBe(1);
    expect(result.assigned).toBe(0);
    const [assignment] = await contractRepo.getNetworkAssignments([c8.id]);
    expect(assignment).toEqual({ id: c8.id, networkSiteId: 'ns-9', accessPointId: 'ap-9-manual' });
  });

  it('matriz #8 — station con missingSince queda excluida de candidatos → unresolved', async () => {
    const { pppoeRepo, uispDeviceRepo, contractRepo, uc } = makeHarness();
    const c9 = contractRepo.seed({ clientName: 'Cliente 9', plan: 'Plan A' });
    await addPppoe(pppoeRepo, { username: 'user9', contractId: c9.id, callerId: 'AA:BB:CC:DD:EE:09' });
    await uispDeviceRepo.upsert(makeStation({
      uispId: 'st-9', mac: 'aabbccddee09', apUispDeviceId: 'apdev-9',
      missingSince: new Date('2026-06-01T00:00:00Z'),
    }));

    const result = await uc.execute();

    expect(result.unresolved).toBe(1);
    expect(result.assigned).toBe(0);
  });

  it('matriz #9 — AP retirado (missingSince != null) con station viva colgada → SE ASIGNA IGUAL', async () => {
    const { pppoeRepo, uispDeviceRepo, accessPointRepo, contractRepo, uc } = makeHarness();
    const c10 = contractRepo.seed({ clientName: 'Cliente 10', plan: 'Plan A' });
    await addPppoe(pppoeRepo, { username: 'user10', contractId: c10.id, callerId: 'AA:BB:CC:DD:EE:10' });
    await uispDeviceRepo.upsert(makeStation({ uispId: 'st-10', mac: 'aabbccddee10', apUispDeviceId: 'apdev-10' }));
    const apRetired = await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'apdev-10', networkSiteId: 'ns-10', name: 'AP retirado', mac: null });
    await accessPointRepo.markMissing(['apdev-10'], new Date('2026-06-01T00:00:00Z'));

    const result = await uc.execute();

    expect(result.assigned).toBe(1);
    const [assignment] = await contractRepo.getNetworkAssignments([c10.id]);
    expect(assignment).toEqual({ id: c10.id, networkSiteId: 'ns-10', accessPointId: apRetired.id });
  });

  it('matriz #10 — AP sin nodo linkeado → escribe par coherente (accessPointId + networkSiteId=null)', async () => {
    const { pppoeRepo, uispDeviceRepo, accessPointRepo, contractRepo, uc } = makeHarness();
    const c11 = contractRepo.seed({ clientName: 'Cliente 11', plan: 'Plan A', networkSiteId: 'ns-old-manual', accessPointId: null });
    await addPppoe(pppoeRepo, { username: 'user11', contractId: c11.id, callerId: 'AA:BB:CC:DD:EE:11' });
    await uispDeviceRepo.upsert(makeStation({ uispId: 'st-11', mac: 'aabbccddee11', apUispDeviceId: 'apdev-11' }));
    const apNoSite = await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'apdev-11', networkSiteId: null, name: 'AP sin nodo', mac: null });

    const result = await uc.execute();

    expect(result.assigned).toBe(1);
    const [assignment] = await contractRepo.getNetworkAssignments([c11.id]);
    expect(assignment).toEqual({ id: c11.id, networkSiteId: null, accessPointId: apNoSite.id });
  });
});

describe('AutoAssignContractNetwork — cobertura de matriz faltante (review M2)', () => {
  it('M2 #1 — station viva matchea por MAC pero apUispDeviceId === null → unresolved', async () => {
    const { pppoeRepo, uispDeviceRepo, contractRepo, uc } = makeHarness();
    const c = contractRepo.seed({ clientName: 'Cliente M2-1', plan: 'Plan A' });
    await addPppoe(pppoeRepo, { username: 'userM2-1', contractId: c.id, callerId: 'AA:BB:CC:DD:EE:21' });
    // apUispDeviceId NO se pasa → default null (makeStation) — la station está viva y matchea
    // por MAC, pero no tiene AP colgado.
    await uispDeviceRepo.upsert(makeStation({ uispId: 'st-m2-1', mac: 'aabbccddee21' }));

    const result = await uc.execute();

    expect(result.unresolved).toBe(1);
    expect(result.assigned).toBe(0);
  });

  it('M2 #2 — apUispDeviceId de la station no existe en el catálogo AccessPoint → unresolved', async () => {
    const { pppoeRepo, uispDeviceRepo, contractRepo, uc } = makeHarness();
    const c = contractRepo.seed({ clientName: 'Cliente M2-2', plan: 'Plan A' });
    await addPppoe(pppoeRepo, { username: 'userM2-2', contractId: c.id, callerId: 'AA:BB:CC:DD:EE:22' });
    await uispDeviceRepo.upsert(makeStation({
      uispId: 'st-m2-2', mac: 'aabbccddee22', apUispDeviceId: 'apdev-orphan-not-in-catalog',
    }));
    // NO se registra ningún AccessPoint con uispDeviceId: 'apdev-orphan-not-in-catalog'.

    const result = await uc.execute();

    expect(result.unresolved).toBe(1);
    expect(result.assigned).toBe(0);
  });

  it('M2 #3 — device con role != station y la MISMA mac → excluido del match (no cuenta como station)', async () => {
    const { pppoeRepo, uispDeviceRepo, accessPointRepo, contractRepo, uc } = makeHarness();
    const c = contractRepo.seed({ clientName: 'Cliente M2-3', plan: 'Plan A' });
    await addPppoe(pppoeRepo, { username: 'userM2-3', contractId: c.id, callerId: 'AA:BB:CC:DD:EE:23' });
    // role 'ap' (NO 'station') con la misma MAC + apUispDeviceId/AP válidos — si el filtro de
    // role no lo excluyera, el contrato terminaría asignado igual.
    await uispDeviceRepo.upsert(makeStation({
      uispId: 'st-m2-3', mac: 'aabbccddee23', role: 'ap', apUispDeviceId: 'apdev-m2-3',
    }));
    await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'apdev-m2-3', networkSiteId: 'ns-m2-3', name: 'AP M2-3', mac: null });

    const result = await uc.execute();

    expect(result.unresolved).toBe(1);
    expect(result.assigned).toBe(0);
  });

  it('M2 #4 — callerId presente pero INVÁLIDO (basura, no-MAC) → cae a la cascada RadiusEvent', async () => {
    const { pppoeRepo, radiusEventRepo, uispDeviceRepo, accessPointRepo, contractRepo, uc } = makeHarness();
    const c = contractRepo.seed({ clientName: 'Cliente M2-4', plan: 'Plan A' });
    // callerId basura: normalizeMac() lo rechaza (no es hex) → distinto de "callerId ausente".
    await addPppoe(pppoeRepo, { username: 'userM2-4', contractId: c.id, callerId: 'not-a-mac-value' });
    await uispDeviceRepo.upsert(makeStation({ uispId: 'st-m2-4', mac: 'aabbccddee24', apUispDeviceId: 'apdev-m2-4' }));
    const ap = await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'apdev-m2-4', networkSiteId: 'ns-m2-4', name: 'AP M2-4', mac: null });
    await radiusEventRepo.upsertMany([{
      sourceUniqueId: 'evt-m2-4', username: 'userM2-4', nasIpAddress: '10.0.0.1', nasId: 'nas-1',
      framedIp: null, macAddress: 'AA:BB:CC:DD:EE:24', vlanId: null,
      startedAt: new Date('2026-07-01T00:00:00Z'), stoppedAt: null, sessionTime: null,
      bytesIn: BigInt(0), bytesOut: BigInt(0), eventType: 'start', status: 'online',
    }]);

    const result = await uc.execute();

    expect(result.macFromCallerId).toBe(0);
    expect(result.macFromRadiusEvent).toBe(1);
    expect(result.assigned).toBe(1);
    const [assignment] = await contractRepo.getNetworkAssignments([c.id]);
    expect(assignment.accessPointId).toBe(ap.id);
  });
});

describe('AutoAssignContractNetwork — desempate de MAC duplicada §6.2', () => {
  it('missing pierde contra viva con la misma mac (no es ambiguo)', async () => {
    const { pppoeRepo, uispDeviceRepo, accessPointRepo, contractRepo, uc } = makeHarness();
    const c = contractRepo.seed({ clientName: 'Cliente D1', plan: 'Plan A' });
    await addPppoe(pppoeRepo, { username: 'userD1', contractId: c.id, callerId: 'AA:BB:CC:DD:EE:D1' });
    await uispDeviceRepo.upsert(makeStation({
      uispId: 'st-d1-dead', mac: 'aabbccddeed1', apUispDeviceId: 'apdev-dead',
      missingSince: new Date('2026-01-01T00:00:00Z'),
    }));
    await uispDeviceRepo.upsert(makeStation({ uispId: 'st-d1-alive', mac: 'aabbccddeed1', apUispDeviceId: 'apdev-alive' }));
    const apAlive = await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'apdev-alive', networkSiteId: 'ns-alive', name: 'AP viva', mac: null });

    const result = await uc.execute();

    expect(result.ambiguous).toBe(0);
    expect(result.assigned).toBe(1);
    const [assignment] = await contractRepo.getNetworkAssignments([c.id]);
    expect(assignment.accessPointId).toBe(apAlive.id);
  });

  it('dos stations vivas con la misma mac: gana la de lastSeenAt más reciente', async () => {
    const { pppoeRepo, uispDeviceRepo, accessPointRepo, contractRepo, uc } = makeHarness();
    const c = contractRepo.seed({ clientName: 'Cliente D2', plan: 'Plan A' });
    await addPppoe(pppoeRepo, { username: 'userD2', contractId: c.id, callerId: 'AA:BB:CC:DD:EE:D2' });
    await uispDeviceRepo.upsert(makeStation({
      uispId: 'st-d2-old', mac: 'aabbccddeed2', apUispDeviceId: 'apdev-d2-old',
      lastSeenAt: new Date('2026-06-01T00:00:00Z'),
    }));
    await uispDeviceRepo.upsert(makeStation({
      uispId: 'st-d2-new', mac: 'aabbccddeed2', apUispDeviceId: 'apdev-d2-new',
      lastSeenAt: new Date('2026-07-01T00:00:00Z'),
    }));
    await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'apdev-d2-old', networkSiteId: 'ns-old', name: 'AP old', mac: null });
    const apNew = await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'apdev-d2-new', networkSiteId: 'ns-new', name: 'AP new', mac: null });

    const result = await uc.execute();

    expect(result.ambiguous).toBe(0);
    const [assignment] = await contractRepo.getNetworkAssignments([c.id]);
    expect(assignment.accessPointId).toBe(apNew.id);
  });

  it('dos stations vivas con la misma mac y el MISMO lastSeenAt → ambiguous, skip + warn', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { pppoeRepo, uispDeviceRepo, contractRepo, uc } = makeHarness();
    const c = contractRepo.seed({ clientName: 'Cliente D3', plan: 'Plan A', networkSiteId: 'ns-manual', accessPointId: 'ap-manual' });
    await addPppoe(pppoeRepo, { username: 'userD3', contractId: c.id, callerId: 'AA:BB:CC:DD:EE:D3' });
    const seenAt = new Date('2026-07-01T00:00:00Z');
    await uispDeviceRepo.upsert(makeStation({ uispId: 'st-d3-a', mac: 'aabbccddeed3', apUispDeviceId: 'apdev-d3-a', lastSeenAt: seenAt }));
    await uispDeviceRepo.upsert(makeStation({ uispId: 'st-d3-b', mac: 'aabbccddeed3', apUispDeviceId: 'apdev-d3-b', lastSeenAt: seenAt }));

    const result = await uc.execute();

    expect(result.ambiguous).toBe(1);
    expect(result.assigned).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    const [assignment] = await contractRepo.getNetworkAssignments([c.id]);
    expect(assignment).toEqual({ id: c.id, networkSiteId: 'ns-manual', accessPointId: 'ap-manual' });
    warnSpy.mockRestore();
  });
});

describe('AutoAssignContractNetwork — cascada de MAC §4 (CAS-2)', () => {
  it('callerId válido gana sobre RadiusEvent (aunque el RadiusEvent matchee otra station)', async () => {
    const { pppoeRepo, radiusEventRepo, uispDeviceRepo, accessPointRepo, contractRepo, uc } = makeHarness();
    const c = contractRepo.seed({ clientName: 'Cliente Casc1', plan: 'Plan A' });
    await addPppoe(pppoeRepo, { username: 'userCasc1', contractId: c.id, callerId: 'AA:BB:CC:DD:EE:C1' });
    await uispDeviceRepo.upsert(makeStation({ uispId: 'st-c1-s1', mac: 'aabbccddeec1', apUispDeviceId: 'apdev-c1-s1' }));
    await uispDeviceRepo.upsert(makeStation({ uispId: 'st-c1-s2', mac: 'aabbccddeec2', apUispDeviceId: 'apdev-c1-s2' }));
    const ap1 = await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'apdev-c1-s1', networkSiteId: 'ns-s1', name: 'AP S1', mac: null });
    await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'apdev-c1-s2', networkSiteId: 'ns-s2', name: 'AP S2', mac: null });
    await radiusEventRepo.upsertMany([{
      sourceUniqueId: 'evt-c1', username: 'userCasc1', nasIpAddress: '10.0.0.1', nasId: 'nas-1',
      framedIp: null, macAddress: 'AA:BB:CC:DD:EE:C2', vlanId: null,
      startedAt: new Date('2026-07-01T00:00:00Z'), stoppedAt: null, sessionTime: null,
      bytesIn: BigInt(0), bytesOut: BigInt(0), eventType: 'start', status: 'online',
    }]);

    const result = await uc.execute();

    expect(result.macFromCallerId).toBe(1);
    expect(result.macFromRadiusEvent).toBe(0);
    const [assignment] = await contractRepo.getNetworkAssignments([c.id]);
    expect(assignment.accessPointId).toBe(ap1.id);
  });

  it('sin callerId válido, cae al RadiusEvent (última sesión online)', async () => {
    const { pppoeRepo, radiusEventRepo, uispDeviceRepo, accessPointRepo, contractRepo, uc } = makeHarness();
    const c = contractRepo.seed({ clientName: 'Cliente Casc2', plan: 'Plan A' });
    await addPppoe(pppoeRepo, { username: 'userCasc2', contractId: c.id });
    await uispDeviceRepo.upsert(makeStation({ uispId: 'st-c2', mac: 'aabbccddeec3', apUispDeviceId: 'apdev-c2' }));
    const ap = await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'apdev-c2', networkSiteId: 'ns-c2', name: 'AP C2', mac: null });
    await radiusEventRepo.upsertMany([{
      sourceUniqueId: 'evt-c2', username: 'userCasc2', nasIpAddress: '10.0.0.1', nasId: 'nas-1',
      framedIp: null, macAddress: 'AA:BB:CC:DD:EE:C3', vlanId: null,
      startedAt: new Date('2026-07-01T00:00:00Z'), stoppedAt: null, sessionTime: null,
      bytesIn: BigInt(0), bytesOut: BigInt(0), eventType: 'start', status: 'online',
    }]);

    const result = await uc.execute();

    expect(result.macFromCallerId).toBe(0);
    expect(result.macFromRadiusEvent).toBe(1);
    const [assignment] = await contractRepo.getNetworkAssignments([c.id]);
    expect(assignment.accessPointId).toBe(ap.id);
  });
});

describe('AutoAssignContractNetwork — write no-op cuenta como escritura real (review L1)', () => {
  it('updateNetworkAssignment devuelve null (contrato inexistente) → NO incrementa assigned', async () => {
    const { pppoeRepo, uispDeviceRepo, accessPointRepo, contractRepo, uc } = makeHarness();
    // contractId NUNCA pasado por contractRepo.seed() — simula una carrera real (el Contract fue
    // borrado entre el read del universo de pppoe y el write) o un contractId huérfano en
    // PppoeService. `updateNetworkAssignment` devuelve null (no hay fila que actualizar):
    // `assigned` debe reflejar escrituras REALES, no intentos.
    const ghostContractId = 'contract-ghost-does-not-exist';
    await addPppoe(pppoeRepo, { username: 'userGhost', contractId: ghostContractId, callerId: 'AA:BB:CC:DD:EE:99' });
    await uispDeviceRepo.upsert(makeStation({ uispId: 'st-ghost', mac: 'aabbccddee99', apUispDeviceId: 'apdev-ghost' }));
    await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'apdev-ghost', networkSiteId: 'ns-ghost', name: 'AP Ghost', mac: null });

    const result = await uc.execute();

    expect(result.assigned).toBe(0);
  });
});

describe('AutoAssignContractNetwork — desempate ESTABLE de candidato PPPoE (review M1)', () => {
  /**
   * M1 (review adversarial) — `createdAt` empatado (TIMESTAMP(3), típico de un ingest bulk) +
   * `PrismaPppoeServiceRepository.list()` SIN `orderBy` garantizado (heap order de Postgres,
   * puede cambiar entre ticks con un simple UPDATE) ⇒ el desempate original
   * (`row.createdAt > best.createdAt`, `>` estricto) resolvía el empate ganando "el primero de
   * la lista" — el mismo no-determinismo disfrazado. Resultado: dos pppoe `enabled` con el MISMO
   * `createdAt` resolviendo a APs distintos hacían que la asignación OSCILARA de tick en tick
   * sin que cambiara ningún dato real (churn/flapping).
   *
   * Reproducimos el bug con un stub de `PppoeServiceRepository.list()` que devuelve LAS MISMAS
   * dos filas (mismo `id`, mismo `createdAt`) en dos ÓRDENES distintas — exactamente la variable
   * que un `findMany()` sin `orderBy` puede cambiar entre llamadas. NO usamos
   * `InMemoryPppoeServiceRepository` acá a propósito: genera `id: randomUUID()` en cada
   * `upsertByUsername`, así que dos corridas nunca comparten los mismos ids y "orden de input"
   * quedaría confundido con "ids distintos al azar" — el stub aísla la única variable que importa.
   */
  function tiedRow(overrides: { id: string; username: string; contractId: string; callerId: string }): PppoeService {
    return {
      id: overrides.id,
      username: overrides.username,
      password: 'x',
      profile: null,
      remoteAddress: null,
      status: 'enabled',
      enforcedState: 'active',
      nasId: 'nas-1',
      contractId: overrides.contractId,
      callerId: overrides.callerId,
      ipMode: 'fixed',
      ipTypePreference: 'cgnat',
      createdAt: '2026-01-01T00:00:00.000Z', // EMPATADO a propósito — es la condición del bug.
    };
  }

  function fixedOrderPppoeRepoStub(rows: PppoeService[]): PppoeServiceRepository {
    return { list: async () => rows } as unknown as PppoeServiceRepository;
  }

  async function buildAndRun(order: 'ab' | 'ba') {
    const radiusEventRepo = new InMemoryRadiusEventRepository();
    const uispDeviceRepo = new InMemoryUispDeviceRepository();
    const accessPointRepo = new InMemoryAccessPointRepository();
    const contractRepo = new InMemoryContractRepository();
    const syncStateRepo = new InMemorySyncStateRepository();

    const c = contractRepo.seed({ clientName: 'Cliente M1-tie', plan: 'Plan A' });

    // Mismo `id` y `createdAt` en AMBAS corridas — solo cambia el ORDEN del array que list()
    // devuelve, la única variable bajo prueba.
    const rowA = tiedRow({ id: 'ppp-fixed-aaaaaaaa', username: 'userTieA', contractId: c.id, callerId: 'AA:BB:CC:DD:EE:A1' });
    const rowB = tiedRow({ id: 'ppp-fixed-bbbbbbbb', username: 'userTieB', contractId: c.id, callerId: 'AA:BB:CC:DD:EE:B1' });
    const pppoeRepo = fixedOrderPppoeRepoStub(order === 'ab' ? [rowA, rowB] : [rowB, rowA]);

    const uc = new AutoAssignContractNetwork(
      pppoeRepo,
      radiusEventRepo,
      uispDeviceRepo,
      accessPointRepo,
      contractRepo,
      syncStateRepo,
    );

    await uispDeviceRepo.upsert(makeStation({ uispId: 'st-tie-a', mac: 'aabbccddeea1', apUispDeviceId: 'apdev-tie-a' }));
    await uispDeviceRepo.upsert(makeStation({ uispId: 'st-tie-b', mac: 'aabbccddeeb1', apUispDeviceId: 'apdev-tie-b' }));
    await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'apdev-tie-a', networkSiteId: 'ns-a', name: 'AP A', mac: null });
    await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'apdev-tie-b', networkSiteId: 'ns-b', name: 'AP B', mac: null });

    await uc.execute();
    const [assignment] = await contractRepo.getNetworkAssignments([c.id]);
    return assignment!;
  }

  it('mismo id/createdAt, orden de list() invertido (símil heap-order de Postgres) ⇒ SIGUE eligiendo el MISMO candidato (no flapping)', async () => {
    const resultOrderAB = await buildAndRun('ab');
    const resultOrderBA = await buildAndRun('ba');

    // Comparamos por networkSiteId (texto estable 'ns-a'/'ns-b') — no por accessPointId: cada
    // corrida crea su PROPIO InMemoryAccessPointRepository fresco, así que el id secuencial
    // ('ap-1'/'ap-2') es determinístico dentro de una corrida pero no es lo que queremos afirmar.
    expect(resultOrderAB.networkSiteId).toBe(resultOrderBA.networkSiteId);
  });
});

describe('AutoAssignContractNetwork — idempotencia (AA-4)', () => {
  it('segunda corrida sin cambios en la data ⇒ 0 writes, todo unchanged', async () => {
    const { pppoeRepo, uispDeviceRepo, accessPointRepo, contractRepo, uc } = makeHarness();
    const c1 = contractRepo.seed({ clientName: 'Cliente I1', plan: 'Plan A' });
    const c2 = contractRepo.seed({ clientName: 'Cliente I2', plan: 'Plan A' });
    await addPppoe(pppoeRepo, { username: 'userI1', contractId: c1.id, callerId: 'AA:BB:CC:DD:EE:F1' });
    await addPppoe(pppoeRepo, { username: 'userI2', contractId: c2.id, callerId: 'AA:BB:CC:DD:EE:F2' });
    await uispDeviceRepo.upsert(makeStation({ uispId: 'st-i1', mac: 'aabbccddeef1', apUispDeviceId: 'apdev-i1' }));
    await uispDeviceRepo.upsert(makeStation({ uispId: 'st-i2', mac: 'aabbccddeef2', apUispDeviceId: 'apdev-i2' }));
    await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'apdev-i1', networkSiteId: 'ns-i1', name: 'AP I1', mac: null });
    await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'apdev-i2', networkSiteId: 'ns-i2', name: 'AP I2', mac: null });

    const first = await uc.execute();
    expect(first.assigned).toBe(2);

    const updateSpy = jest.spyOn(contractRepo, 'updateNetworkAssignment');
    const second = await uc.execute();

    expect(second.assigned).toBe(0);
    expect(second.unchanged).toBe(2);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

describe('AutoAssignContractNetwork — métricas y SyncState (§7)', () => {
  it('devuelve las 8 métricas completas incluso en un universo vacío', async () => {
    const { uc } = makeHarness();

    const result = await uc.execute();

    expect(result).toEqual({
      contractsEvaluated: 0,
      assigned: 0,
      unchanged: 0,
      unresolved: 0,
      ambiguous: 0,
      macFromCallerId: 0,
      macFromRadiusEvent: 0,
      durationMs: expect.any(Number),
    });
  });

  it('persiste SyncState(contract-network-auto-assign) con ok:{json} y las métricas del run', async () => {
    const { pppoeRepo, uispDeviceRepo, accessPointRepo, contractRepo, syncStateRepo, uc } = makeHarness();
    const c1 = contractRepo.seed({ clientName: 'Cliente M1', plan: 'Plan A' });
    await addPppoe(pppoeRepo, { username: 'userM1', contractId: c1.id, callerId: 'AA:BB:CC:DD:EE:F1' });
    await uispDeviceRepo.upsert(makeStation({ uispId: 'st-m1', mac: 'aabbccddeef1', apUispDeviceId: 'apdev-m1' }));
    await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'apdev-m1', networkSiteId: 'ns-m1', name: 'AP M1', mac: null });

    await uc.execute();

    const state = await syncStateRepo.get('contract-network-auto-assign');
    expect(state).not.toBeNull();
    expect(state!.lastResult).toMatch(/^ok:/);
    const json = JSON.parse(state!.lastResult!.slice('ok:'.length).trim());
    expect(json.assigned).toBe(1);
    expect(typeof json.durationMs).toBe('number');
  });

  it('catch interno: un repo que lanza persiste SyncState error:<msg> y RE-LANZA (el scheduler decide)', async () => {
    const { pppoeRepo, uispDeviceRepo, contractRepo, syncStateRepo, uc } = makeHarness();
    const c1 = contractRepo.seed({ clientName: 'Cliente E1', plan: 'Plan A' });
    await addPppoe(pppoeRepo, { username: 'userE1', contractId: c1.id, callerId: 'AA:BB:CC:DD:EE:E1' });
    jest.spyOn(uispDeviceRepo, 'listAll').mockRejectedValue(new Error('boom'));

    await expect(uc.execute()).rejects.toThrow('boom');

    const state = await syncStateRepo.get('contract-network-auto-assign');
    expect(state).not.toBeNull();
    expect(state!.lastResult).toBe('error: boom');
  });
});
