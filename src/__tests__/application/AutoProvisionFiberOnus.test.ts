/**
 * K3 (fiber-auto-watcher) — AutoProvisionFiberOnus: núcleo del watcher full-auto.
 *
 * El técnico carga el SERIAL de la ONU en la tarea de instalación; el watcher
 * detecta la ONU sin configurar en SmartOLT cuyo SN matchea y la aprovisiona
 * SOLO (reusa ProvisionFiberOnu con dryRun:false + origin 'watcher').
 * TODO con fakes — JAMÁS la API viva de SmartOLT.
 *
 * Reglas cubiertas:
 *  - Match exacto por SN, case-insensitive (serial normalizado vs sn canónico).
 *  - Cero candidatas → NI SIQUIERA llama a listUnconfiguredOnus (rate limit).
 *  - No-match / tareas archivadas / sin contrato → nada que tocar.
 *  - Éxito → bloque auditable con "(aprovisionada AUTOMÁTICAMENTE por el watcher)".
 *  - FIBER_VLAN_REQUIRED (CHIVILCOY) → UNA nota, status manual-required, sin reintentos.
 *  - ONU no-Huawei → UNA nota, manual-required, sin reintentos.
 *  - Fallo transitorio → backoff (no en el mismo tick ni el siguiente) → 3er fallo →
 *    nota + failed-final, no insistir más. Persistido en FiberAutoProvisionAttempt.
 *  - Dos tareas con el MISMO serial → conflicto: nota en AMBAS, NO aprovisionar;
 *    si el humano resuelve (limpia un serial) el watcher REANUDA la otra.
 */
import {
  AutoProvisionFiberOnus,
  WATCHER_NOTE_VLAN_MANUAL,
  WATCHER_NOTE_NON_HUAWEI,
  watcherNoteFailedFinal,
  watcherNoteConflict,
} from '@application/use-cases/AutoProvisionFiberOnus';
import { ProvisionFiberOnu, FiberContractLookup, FiberContractSnapshot } from '@application/use-cases/ProvisionFiberOnu';
import { PregenInstallPppoe } from '@application/use-cases/PregenInstallPppoe';
import { CreatePppoeService } from '@application/use-cases/CreatePppoeService';
import { EnsureInternetContractService } from '@application/use-cases/EnsureInternetContractService';
import { InMemoryOltProvisioningGateway } from '@infrastructure/adapters/in-memory/InMemoryOltProvisioningGateway';
import { InMemorySmartOltOltConfigRepository } from '@infrastructure/adapters/in-memory/InMemorySmartOltOltConfigRepository';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { InMemoryGestionRealIngestConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryGestionRealIngestConfigRepository';
import { InMemoryFiberAutoProvisionTaskRepository } from '@infrastructure/adapters/in-memory/InMemoryFiberAutoProvisionTaskRepository';
import { InMemoryFiberAutoProvisionAttemptRepository } from '@infrastructure/adapters/in-memory/InMemoryFiberAutoProvisionAttemptRepository';
import type { UnconfiguredOnu } from '@domain/ports/OltProvisioningGateway';
import type { FiberAutoProvisionAttempt } from '@domain/ports/FiberAutoProvisionAttemptRepository';
import { OltProvisioningError, UnconfiguredOnuNotFoundError } from '@domain/errors/smartolt';

const PROFILE = 'IP-FTTH-300';
const SN = 'HWTC11112222';
/** Backoff del fixture: 2 ticks de 5min. */
const BACKOFF_MS = 600_000;

class FakeContractLookup implements FiberContractLookup {
  contracts = new Map<string, FiberContractSnapshot>();
  async findById(id: string): Promise<FiberContractSnapshot | null> {
    const c = this.contracts.get(id);
    return c ? { ...c } : null;
  }
}

function huaweiOnu(overrides: Partial<UnconfiguredOnu> = {}): UnconfiguredOnu {
  return {
    sn: SN,
    onuTypeName: 'HG8546M',
    onuTypeId: '15',
    oltId: '1',
    board: '0',
    port: '3',
    ponType: 'gpon',
    supportsAuthorize: true,
    ...overrides,
  };
}

interface Fixture {
  watcher: AutoProvisionFiberOnus;
  provision: ProvisionFiberOnu;
  gateway: InMemoryOltProvisioningGateway;
  taskRepo: InMemoryFiberAutoProvisionTaskRepository;
  attemptRepo: InMemoryFiberAutoProvisionAttemptRepository;
  pppoeRepo: InMemoryPppoeServiceRepository;
  contracts: FakeContractLookup;
  clock: { now: Date };
}

async function buildFixture(): Promise<Fixture> {
  const gateway = new InMemoryOltProvisioningGateway();
  gateway.unconfigured = [huaweiOnu()];

  const oltRepo = new InMemorySmartOltOltConfigRepository();
  oltRepo.seed({ id: 'olt-m1', smartoltOltId: '1', name: 'MERCEDES1', serviceVlanDefault: 246, mgmtVlan: 11 });
  oltRepo.seed({ id: 'olt-ch', smartoltOltId: '3', name: 'CHIVILCOY X2', serviceVlanDefault: null, mgmtVlan: null });

  const contracts = new FakeContractLookup();
  contracts.contracts.set('ctr-1', {
    id: 'ctr-1',
    plan: '300MB',
    grContratoId: '45123',
    clientId: 'cli-1',
    clientName: 'HERNANDEZ RONALD',
    grClienteId: 'gr-cli-1',
  });
  contracts.contracts.set('ctr-2', {
    id: 'ctr-2',
    plan: '300MB',
    grContratoId: '45999',
    clientId: 'cli-2',
    clientName: 'LOPEZ MARIA',
    grClienteId: 'gr-cli-2',
  });

  const pppoeRepo = new InMemoryPppoeServiceRepository();
  const createPppoe = new CreatePppoeService(
    pppoeRepo,
    new InMemoryRouterGateway(),
    new InMemoryNasRepository(),
    new InMemoryRadiusOrchestratorGateway(),
    new EnsureInternetContractService(
      new InMemoryContractServiceRepository(),
      new InMemoryServiceCatalogRepository(),
    ),
  );
  const pregen = new PregenInstallPppoe(pppoeRepo, createPppoe, new InMemoryGestionRealPort());

  const ingestConfig = new InMemoryGestionRealIngestConfigRepository();
  await ingestConfig.update({ pppoeProfile: PROFILE });

  // UNA fuente de verdad de tareas: el mismo store sirve al watcher (candidatas +
  // notas) y a ProvisionFiberOnu (bloque auditable via FiberInstallTaskWriter).
  const taskRepo = new InMemoryFiberAutoProvisionTaskRepository();

  const provision = new ProvisionFiberOnu(
    gateway,
    oltRepo,
    contracts,
    pppoeRepo,
    pregen,
    ingestConfig,
    taskRepo,
    { rng: () => 0.7 },
  );

  const attemptRepo = new InMemoryFiberAutoProvisionAttemptRepository();
  const clock = { now: new Date('2026-07-16T12:00:00Z') };
  const watcher = new AutoProvisionFiberOnus(taskRepo, attemptRepo, gateway, provision, {
    retryBackoffMs: BACKOFF_MS,
    now: () => clock.now,
  });

  return { watcher, provision, gateway, taskRepo, attemptRepo, pppoeRepo, contracts, clock };
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('AutoProvisionFiberOnus — sin trabajo', () => {
  it('cero tareas candidatas → NI SIQUIERA llama a listUnconfiguredOnus (respeta rate limit)', async () => {
    const fx = await buildFixture();

    const summary = await fx.watcher.run();

    expect(fx.gateway.calls).toHaveLength(0);
    expect(summary).toEqual({
      candidates: 0, unconfigured: 0, matched: 0, provisioned: 0, failed: 0, skipped: 0,
    });
  });

  it('tarea con serial que NO matchea ninguna ONU → nada: sin escrituras, sin registros de intento', async () => {
    const fx = await buildFixture();
    fx.taskRepo.tasks.push({ id: 'task-1', contractId: 'ctr-1', onuSerial: 'HWTC99998888', archivedAt: null, description: null });

    const summary = await fx.watcher.run();

    expect(summary).toMatchObject({ candidates: 1, unconfigured: 1, matched: 0, provisioned: 0 });
    expect(fx.gateway.writeSequence()).toEqual([]);
    // UNA sola llamada a listUnconfiguredOnus en todo el tick (la del match).
    expect(fx.gateway.calls.filter(c => c.method === 'listUnconfiguredOnus')).toHaveLength(1);
    expect(fx.attemptRepo.all()).toHaveLength(0);
  });

  it('tarea ARCHIVADA con serial → ignorada (ni cuenta como candidata)', async () => {
    const fx = await buildFixture();
    fx.taskRepo.tasks.push({ id: 'task-1', contractId: 'ctr-1', onuSerial: SN, archivedAt: '2026-07-01T00:00:00Z', description: null });

    const summary = await fx.watcher.run();

    expect(summary.candidates).toBe(0);
    expect(fx.gateway.calls).toHaveLength(0);
  });

  it('tarea SIN contrato con serial que matchea → skipped, sin aprovisionar', async () => {
    const fx = await buildFixture();
    fx.taskRepo.tasks.push({ id: 'task-1', contractId: null, onuSerial: SN, archivedAt: null, description: null });

    const summary = await fx.watcher.run();

    expect(summary).toMatchObject({ candidates: 1, matched: 1, provisioned: 0, skipped: 1 });
    expect(fx.gateway.writeSequence()).toEqual([]);
  });
});

describe('AutoProvisionFiberOnus — provisión exitosa', () => {
  it('match case-insensitive → aprovisiona SOLO: secuencia completa + bloque con origin watcher', async () => {
    const fx = await buildFixture();
    // Serial guardado en minúsculas (defensa: el watcher normaliza igual).
    fx.taskRepo.tasks.push({ id: 'task-1', contractId: 'ctr-1', onuSerial: 'hwtc11112222', archivedAt: null, description: null });

    const summary = await fx.watcher.run();

    expect(summary).toMatchObject({ candidates: 1, matched: 1, provisioned: 1, failed: 0, skipped: 0 });
    expect(fx.gateway.writeSequence()).toEqual([
      'authorizeOnu',
      'setMgmtIp',
      'enableTr069',
      'allowRemoteWanAccess',
      'setWifi:wifi_0/1',
      'setWifi:wifi_0/5',
    ]);
    // Bloque auditable en la tarea, CON la línea de origen automático.
    const description = fx.taskRepo.tasks[0]!.description!;
    expect(description).toContain('── Aprovisionamiento ONU ──');
    expect(description).toContain(`SN: ${SN}`);
    expect(description).toContain('(aprovisionada AUTOMÁTICAMENTE por el watcher)');
    // Registro persistido: succeeded, 1 intento.
    expect(await fx.attemptRepo.find('task-1', SN)).toMatchObject({ attempts: 1, status: 'succeeded' });
  });

  it('el aprovisionamiento MANUAL (sin origin) NO lleva la línea del watcher — el bloque K2 queda intacto', async () => {
    const fx = await buildFixture();
    fx.taskRepo.tasks.push({ id: 'task-1', contractId: 'ctr-1', onuSerial: null, archivedAt: null, description: null });

    await fx.provision.execute({ contractId: 'ctr-1', onuSn: SN });

    const description = fx.taskRepo.tasks[0]!.description!;
    expect(description).toContain('── Aprovisionamiento ONU ──');
    expect(description).not.toContain('(aprovisionada AUTOMÁTICAMENTE por el watcher)');
  });

  it('tras el éxito, si la ONU sigue apareciendo sin configurar (lag SmartOLT) NO se re-aprovisiona', async () => {
    const fx = await buildFixture();
    fx.taskRepo.tasks.push({ id: 'task-1', contractId: 'ctr-1', onuSerial: SN, archivedAt: null, description: null });
    await fx.watcher.run();
    const writesAfterSuccess = fx.gateway.writeSequence().length;

    const second = await fx.watcher.run();

    expect(second).toMatchObject({ provisioned: 0, skipped: 1 });
    expect(fx.gateway.writeSequence()).toHaveLength(writesAfterSuccess);
  });
});

describe('AutoProvisionFiberOnus — VLAN irresoluble (CHIVILCOY)', () => {
  it('FIBER_VLAN_REQUIRED → UNA nota en la tarea, manual-required, sin reintentos ni escrituras', async () => {
    const fx = await buildFixture();
    fx.gateway.unconfigured = [huaweiOnu({ oltId: '3' })]; // CHIVILCOY: sin VLAN default
    fx.taskRepo.tasks.push({ id: 'task-1', contractId: 'ctr-1', onuSerial: SN, archivedAt: null, description: null });

    const first = await fx.watcher.run();
    const second = await fx.watcher.run();

    expect(first).toMatchObject({ matched: 1, provisioned: 0, failed: 0, skipped: 1 });
    expect(second).toMatchObject({ matched: 1, provisioned: 0, skipped: 1 });
    expect(fx.gateway.writeSequence()).toEqual([]); // jamás llegó al authorize
    const description = fx.taskRepo.tasks[0]!.description!;
    expect(countOccurrences(description, WATCHER_NOTE_VLAN_MANUAL)).toBe(1); // nota ÚNICA
    expect(await fx.attemptRepo.find('task-1', SN)).toMatchObject({ status: 'manual-required' });
  });
});

describe('AutoProvisionFiberOnus — ONU no-Huawei', () => {
  it('serial ZTE cargado → UNA nota "aprovisionar manualmente", manual-required, sin tocar el gateway de escritura', async () => {
    const fx = await buildFixture();
    const zteSn = 'ZTEGC1234567';
    fx.gateway.unconfigured = [huaweiOnu({ sn: zteSn })];
    fx.taskRepo.tasks.push({ id: 'task-1', contractId: 'ctr-1', onuSerial: zteSn, archivedAt: null, description: null });

    const first = await fx.watcher.run();
    const second = await fx.watcher.run();

    expect(first).toMatchObject({ matched: 1, provisioned: 0, failed: 0, skipped: 1 });
    expect(second).toMatchObject({ skipped: 1 });
    expect(fx.gateway.writeSequence()).toEqual([]);
    const description = fx.taskRepo.tasks[0]!.description!;
    expect(countOccurrences(description, WATCHER_NOTE_NON_HUAWEI)).toBe(1);
    expect(await fx.attemptRepo.find('task-1', zteSn)).toMatchObject({ status: 'manual-required' });
  });
});

describe('AutoProvisionFiberOnus — fallos transitorios: backoff + tope de 3 intentos', () => {
  it('fallo → pending(1); reintento inmediato BLOQUEADO (backoff); pasa el backoff → reintenta; al 3ro → nota + failed-final + stop', async () => {
    const fx = await buildFixture();
    fx.gateway.failMethods = ['authorizeOnu'];
    fx.taskRepo.tasks.push({ id: 'task-1', contractId: 'ctr-1', onuSerial: SN, archivedAt: null, description: null });

    // Intento 1 — falla (transitorio).
    const t1 = await fx.watcher.run();
    expect(t1).toMatchObject({ matched: 1, failed: 1, provisioned: 0 });
    expect(await fx.attemptRepo.find('task-1', SN)).toMatchObject({ attempts: 1, status: 'pending' });

    // Mismo instante (mismo tick / tick siguiente) → NO reintenta.
    const t2 = await fx.watcher.run();
    expect(t2).toMatchObject({ failed: 0, skipped: 1 });
    expect(await fx.attemptRepo.find('task-1', SN)).toMatchObject({ attempts: 1 });

    // Pasa el backoff → intento 2.
    fx.clock.now = new Date(fx.clock.now.getTime() + BACKOFF_MS);
    const t3 = await fx.watcher.run();
    expect(t3).toMatchObject({ failed: 1 });
    expect(await fx.attemptRepo.find('task-1', SN)).toMatchObject({ attempts: 2, status: 'pending' });

    // Pasa el backoff → intento 3 → tope: nota + failed-final.
    fx.clock.now = new Date(fx.clock.now.getTime() + BACKOFF_MS);
    const t4 = await fx.watcher.run();
    expect(t4).toMatchObject({ failed: 1 });
    const rec = await fx.attemptRepo.find('task-1', SN);
    expect(rec).toMatchObject({ attempts: 3, status: 'failed-final' });
    const description = fx.taskRepo.tasks[0]!.description!;
    expect(countOccurrences(description, watcherNoteFailedFinal(3, rec!.lastError!))).toBe(1);

    // Ya no insiste NUNCA más (aunque pase el backoff).
    fx.clock.now = new Date(fx.clock.now.getTime() + BACKOFF_MS * 10);
    const t5 = await fx.watcher.run();
    expect(t5).toMatchObject({ failed: 0, skipped: 1 });
    expect(await fx.attemptRepo.find('task-1', SN)).toMatchObject({ attempts: 3, status: 'failed-final' });
    expect(countOccurrences(fx.taskRepo.tasks[0]!.description!, '⚠')).toBe(1); // sin notas duplicadas
  });

  it('fallo transitorio que luego SE CURA: reintento (post-backoff) aprovisiona y marca succeeded', async () => {
    const fx = await buildFixture();
    fx.gateway.failMethods = ['authorizeOnu'];
    fx.taskRepo.tasks.push({ id: 'task-1', contractId: 'ctr-1', onuSerial: SN, archivedAt: null, description: null });

    await fx.watcher.run(); // intento 1 falla
    fx.gateway.failMethods = []; // SmartOLT se recupera
    fx.clock.now = new Date(fx.clock.now.getTime() + BACKOFF_MS);

    const summary = await fx.watcher.run();

    expect(summary).toMatchObject({ provisioned: 1, failed: 0 });
    expect(await fx.attemptRepo.find('task-1', SN)).toMatchObject({ attempts: 2, status: 'succeeded' });
    expect(fx.taskRepo.tasks[0]!.description!).toContain('(aprovisionada AUTOMÁTICAMENTE por el watcher)');
  });
});

describe('AutoProvisionFiberOnus — conflicto: dos tareas con el MISMO serial', () => {
  it('nota en AMBAS tareas, NO aprovisiona (ambigüedad = humano decide); sin notas duplicadas al tick siguiente', async () => {
    const fx = await buildFixture();
    fx.taskRepo.tasks.push({ id: 'task-1', contractId: 'ctr-1', onuSerial: SN, archivedAt: null, description: null });
    fx.taskRepo.tasks.push({ id: 'task-2', contractId: 'ctr-2', onuSerial: SN, archivedAt: null, description: null });

    const first = await fx.watcher.run();
    const second = await fx.watcher.run();

    expect(first).toMatchObject({ candidates: 2, matched: 2, provisioned: 0, skipped: 2 });
    expect(second).toMatchObject({ provisioned: 0, skipped: 2 });
    expect(fx.gateway.writeSequence()).toEqual([]);
    for (const task of fx.taskRepo.tasks) {
      expect(countOccurrences(task.description!, watcherNoteConflict(SN))).toBe(1);
    }
    expect(await fx.attemptRepo.find('task-1', SN)).toMatchObject({ status: 'conflict' });
    expect(await fx.attemptRepo.find('task-2', SN)).toMatchObject({ status: 'conflict' });
  });

  it('humano resuelve (limpia el serial de una) → el watcher REANUDA la otra y aprovisiona', async () => {
    const fx = await buildFixture();
    fx.taskRepo.tasks.push({ id: 'task-1', contractId: 'ctr-1', onuSerial: SN, archivedAt: null, description: null });
    fx.taskRepo.tasks.push({ id: 'task-2', contractId: 'ctr-2', onuSerial: SN, archivedAt: null, description: null });
    await fx.watcher.run(); // conflicto en ambas

    fx.taskRepo.tasks[1]!.onuSerial = null; // el humano decide: task-2 no era

    const summary = await fx.watcher.run();

    expect(summary).toMatchObject({ matched: 1, provisioned: 1 });
    expect(await fx.attemptRepo.find('task-1', SN)).toMatchObject({ status: 'succeeded' });
    expect(fx.taskRepo.tasks[0]!.description!).toContain('(aprovisionada AUTOMÁTICAMENTE por el watcher)');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FIX WAVE — review adversarial sobre 93734a04 (C1, H2, M3, M4, L6, L7, L8)
// ═══════════════════════════════════════════════════════════════════════════════

describe('C1 (CRITICAL) — los estados terminales son INTOCABLES y salen de la ecuación de conflicto', () => {
  it('reuso legítimo de ONU: tarea vieja succeeded + tarea nueva con el mismo serial → NO es conflicto, la NUEVA se aprovisiona', async () => {
    const fx = await buildFixture();
    fx.taskRepo.tasks.push({ id: 'task-a', contractId: 'ctr-1', onuSerial: SN, archivedAt: null, description: null });
    await fx.watcher.run(); // A aprovisionada → succeeded
    expect(await fx.attemptRepo.find('task-a', SN)).toMatchObject({ status: 'succeeded' });

    // La ONU se recicla para un cliente NUEVO (sigue/vuelve a estar unconfigured) y
    // el técnico carga el MISMO serial en la tarea B.
    fx.taskRepo.tasks.push({ id: 'task-b', contractId: 'ctr-2', onuSerial: SN, archivedAt: null, description: null });

    const summary = await fx.watcher.run();

    // B se aprovisiona (el par terminal de A NO participa de la ambigüedad).
    expect(summary).toMatchObject({ matched: 2, provisioned: 1, skipped: 1 });
    expect(await fx.attemptRepo.find('task-b', SN)).toMatchObject({ status: 'succeeded' });
    // El succeeded de A quedó INTACTO — jamás pisado a conflict.
    expect(await fx.attemptRepo.find('task-a', SN)).toMatchObject({ status: 'succeeded', attempts: 1 });
    // Sin notas de conflicto en ninguna.
    for (const task of fx.taskRepo.tasks) {
      expect(task.description ?? '').not.toContain('BLOQUEADO');
    }
  });

  it('escenario COMPLETO del review: succeeded jamás se vuelve reanudable — la ONU del cliente nuevo NO se configura con datos del viejo', async () => {
    const fx = await buildFixture();
    fx.taskRepo.tasks.push({ id: 'task-a', contractId: 'ctr-1', onuSerial: SN, archivedAt: null, description: null });
    await fx.watcher.run(); // A succeeded (1 authorize)

    fx.taskRepo.tasks.push({ id: 'task-b', contractId: 'ctr-2', onuSerial: SN, archivedAt: null, description: null });
    await fx.watcher.run(); // B succeeded (2do authorize) — sin conflicto

    // El humano limpia el serial de B; la ONU se factory-resetea cualquier día
    // y reaparece unconfigured. A es la ÚNICA candidata con ese serial.
    fx.taskRepo.tasks[1]!.onuSerial = null;
    const summary = await fx.watcher.run();

    // A está succeeded → skip. JAMÁS un tercer authorize con los datos viejos de A.
    expect(summary).toMatchObject({ matched: 1, provisioned: 0, skipped: 1 });
    expect(fx.gateway.calls.filter(c => c.method === 'authorizeOnu')).toHaveLength(2);
    expect(await fx.attemptRepo.find('task-a', SN)).toMatchObject({ status: 'succeeded' });
  });

  it('conflicto GENUINO con un tercero terminal: B y C conflictúan entre sí, el succeeded de A ni se toca ni recibe nota', async () => {
    const fx = await buildFixture();
    fx.taskRepo.tasks.push({ id: 'task-a', contractId: 'ctr-1', onuSerial: SN, archivedAt: null, description: null });
    await fx.watcher.run(); // A succeeded
    const aDescription = fx.taskRepo.tasks[0]!.description;

    fx.taskRepo.tasks.push({ id: 'task-b', contractId: 'ctr-2', onuSerial: SN, archivedAt: null, description: null });
    fx.taskRepo.tasks.push({ id: 'task-c', contractId: 'ctr-1', onuSerial: SN, archivedAt: null, description: null });

    const summary = await fx.watcher.run();

    expect(summary).toMatchObject({ matched: 3, provisioned: 0, skipped: 3 });
    expect(await fx.attemptRepo.find('task-a', SN)).toMatchObject({ status: 'succeeded' });
    expect(await fx.attemptRepo.find('task-b', SN)).toMatchObject({ status: 'conflict' });
    expect(await fx.attemptRepo.find('task-c', SN)).toMatchObject({ status: 'conflict' });
    // A no recibió la nota de conflicto (su description no cambió en este tick).
    expect(fx.taskRepo.tasks[0]!.description).toBe(aDescription);
    expect(fx.taskRepo.tasks[1]!.description!).toContain('BLOQUEADO');
    expect(fx.taskRepo.tasks[2]!.description!).toContain('BLOQUEADO');
  });
});

describe('H2 (HIGH) — tareas CERRADAS salen de candidatas (no solo las archivadas)', () => {
  it('tarea cerrada-no-archivada con serial → fuera de candidatas, el gateway ni se toca', async () => {
    const fx = await buildFixture();
    fx.taskRepo.tasks.push({
      id: 'task-1', contractId: 'ctr-1', onuSerial: SN, archivedAt: null, description: null,
      generalStatus: 'closed',
    });

    const summary = await fx.watcher.run();

    expect(summary.candidates).toBe(0);
    expect(fx.gateway.calls).toHaveLength(0);
  });

  it('tarea dismissed con serial → fuera de candidatas', async () => {
    const fx = await buildFixture();
    fx.taskRepo.tasks.push({
      id: 'task-1', contractId: 'ctr-1', onuSerial: SN, archivedAt: null, description: null,
      generalStatus: 'dismissed',
    });

    const summary = await fx.watcher.run();

    expect(summary.candidates).toBe(0);
    expect(fx.gateway.calls).toHaveLength(0);
  });
});

describe('M3 — la ambigüedad se evalúa sobre TODOS los matches del serial (con o sin contrato)', () => {
  it('serial duplicado entre tarea CON contrato y tarea SIN contrato → conflicto: nota en ambas, NO aprovisiona', async () => {
    const fx = await buildFixture();
    fx.taskRepo.tasks.push({ id: 'task-1', contractId: 'ctr-1', onuSerial: SN, archivedAt: null, description: null });
    fx.taskRepo.tasks.push({ id: 'task-2', contractId: null, onuSerial: SN, archivedAt: null, description: null });

    const summary = await fx.watcher.run();

    expect(summary).toMatchObject({ matched: 2, provisioned: 0, skipped: 2 });
    expect(fx.gateway.writeSequence()).toEqual([]);
    for (const task of fx.taskRepo.tasks) {
      expect(countOccurrences(task.description!, watcherNoteConflict(SN))).toBe(1);
    }
    expect(await fx.attemptRepo.find('task-1', SN)).toMatchObject({ status: 'conflict' });
    expect(await fx.attemptRepo.find('task-2', SN)).toMatchObject({ status: 'conflict' });
  });
});

describe('M4 — el bloque de éxito aterriza en la tarea MATCHEADA', () => {
  it('contrato con tarea de instalación (matcheada) + tarea nueva de reclamo → las credenciales van a la MATCHEADA', async () => {
    const fx = await buildFixture();
    fx.taskRepo.tasks.push({ id: 'task-install', contractId: 'ctr-1', onuSerial: SN, archivedAt: null, description: null });
    // Tarea MÁS NUEVA del mismo contrato (findLatestByContract la devolvería a ELLA).
    fx.taskRepo.tasks.push({ id: 'task-reclamo', contractId: 'ctr-1', onuSerial: null, archivedAt: null, description: 'Reclamo: señal intermitente' });

    const summary = await fx.watcher.run();

    expect(summary).toMatchObject({ provisioned: 1 });
    expect(fx.taskRepo.tasks[0]!.description!).toContain('── Aprovisionamiento ONU ──');
    expect(fx.taskRepo.tasks[0]!.description!).toContain('(aprovisionada AUTOMÁTICAMENTE por el watcher)');
    // El reclamo NO recibió credenciales ajenas a su asunto.
    expect(fx.taskRepo.tasks[1]!.description!).not.toContain('── Aprovisionamiento ONU ──');
  });
});

describe('L6 — write-ahead: el attempt se persiste ANTES del provision', () => {
  it('durante el provision el registro YA está en pending con attempts+1 (un crash a mitad no pierde el intento)', async () => {
    const fx = await buildFixture();
    fx.taskRepo.tasks.push({ id: 'task-1', contractId: 'ctr-1', onuSerial: SN, archivedAt: null, description: null });
    let recordDuringProvision: FiberAutoProvisionAttempt | null = null;
    jest.spyOn(fx.provision, 'execute').mockImplementation(async () => {
      recordDuringProvision = await fx.attemptRepo.find('task-1', SN);
      throw new OltProvisioningError('unreachable', 'crash simulado');
    });

    await fx.watcher.run();

    // El write-ahead quedó ANTES de ejecutar: tras un crash el backoff ya rige.
    expect(recordDuringProvision).toMatchObject({ attempts: 1, status: 'pending' });
    expect(await fx.attemptRepo.find('task-1', SN)).toMatchObject({ attempts: 1, status: 'pending' });
  });
});

describe('L7 — el estado terminal se persiste ANTES de la nota (la nota es best-effort)', () => {
  it('VLAN manual: cuando la nota se escribe el estado YA es manual-required; si la nota FALLA el tick no explota y no se duplica nada', async () => {
    const fx = await buildFixture();
    fx.gateway.unconfigured = [huaweiOnu({ oltId: '3' })]; // CHIVILCOY → VLAN manual
    fx.taskRepo.tasks.push({ id: 'task-1', contractId: 'ctr-1', onuSerial: SN, archivedAt: null, description: null });
    let statusWhenNoteWritten: string | undefined;
    const spy = jest.spyOn(fx.taskRepo, 'appendNote').mockImplementation(async (taskId: string) => {
      statusWhenNoteWritten = (await fx.attemptRepo.find(taskId, SN))?.status;
      throw new Error('db caída escribiendo la nota');
    });

    const first = await fx.watcher.run(); // NO debe rechazar

    expect(statusWhenNoteWritten).toBe('manual-required');
    expect(first).toMatchObject({ skipped: 1, failed: 0 });

    // El estado quedó: el próximo tick NO re-intenta (aunque la nota se haya perdido).
    spy.mockRestore();
    const second = await fx.watcher.run();
    expect(second).toMatchObject({ skipped: 1, provisioned: 0 });
    expect(await fx.attemptRepo.find('task-1', SN)).toMatchObject({ status: 'manual-required' });
  });

  it('failed-final: el estado se persiste ANTES de la nota', async () => {
    const fx = await buildFixture();
    fx.gateway.failMethods = ['authorizeOnu'];
    fx.taskRepo.tasks.push({ id: 'task-1', contractId: 'ctr-1', onuSerial: SN, archivedAt: null, description: null });
    let statusWhenNoteWritten: string | undefined;
    const orig = fx.taskRepo.appendNote.bind(fx.taskRepo);
    jest.spyOn(fx.taskRepo, 'appendNote').mockImplementation(async (taskId: string, note: string) => {
      statusWhenNoteWritten = (await fx.attemptRepo.find(taskId, SN))?.status;
      return orig(taskId, note);
    });

    await fx.watcher.run(); // intento 1
    fx.clock.now = new Date(fx.clock.now.getTime() + BACKOFF_MS);
    await fx.watcher.run(); // intento 2
    fx.clock.now = new Date(fx.clock.now.getTime() + BACKOFF_MS);
    await fx.watcher.run(); // intento 3 → failed-final + nota

    expect(statusWhenNoteWritten).toBe('failed-final');
  });
});

describe('L8 — carrera con el wizard: UnconfiguredOnuNotFoundError es skip transitorio', () => {
  it('la ONU desapareció entre el listado y el provision → NO incrementa attempts, NO marca fallo, NO nota', async () => {
    const fx = await buildFixture();
    fx.taskRepo.tasks.push({ id: 'task-1', contractId: 'ctr-1', onuSerial: SN, archivedAt: null, description: null });
    jest.spyOn(fx.provision, 'execute').mockRejectedValueOnce(new UnconfiguredOnuNotFoundError(SN));

    const summary = await fx.watcher.run();

    expect(summary).toMatchObject({ matched: 1, provisioned: 0, failed: 0, skipped: 1 });
    const record = await fx.attemptRepo.find('task-1', SN);
    expect(record?.attempts ?? 0).toBe(0); // el intento NO cuenta
    expect(record?.status ?? 'pending').toBe('pending'); // jamás terminal por una carrera
    expect(fx.taskRepo.tasks[0]!.description ?? '').not.toContain('⚠');

    // El próximo tick la ONU ya no está unconfigured → ni siquiera matchea.
    fx.gateway.unconfigured = [];
    const next = await fx.watcher.run();
    expect(next).toMatchObject({ matched: 0, failed: 0 });
  });
});
