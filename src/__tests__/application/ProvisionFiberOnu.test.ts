/**
 * smartolt-provision (K2) — ProvisionFiberOnu: aprovisionamiento automático de
 * una ONU fibra Huawei vía el port OltProvisioningGateway (fake in-memory,
 * JAMÁS la API viva de SmartOLT).
 *
 * Reglas cubiertas:
 *  - Solo Huawei (sn prefijo HWTC) — otro vendor rechaza tipado SIN tocar el gateway.
 *  - VLAN = input.vlan ?? default del catálogo del OLT; sin ninguna → FIBER_VLAN_REQUIRED
 *    (CHIVILCOY X2 no tiene default: el operador la elige).
 *  - Secuencia: authorize → mgmt ip (si mgmtVlan) → tr069 → remote wan → wifi 2.4 → wifi 5.
 *  - Gotcha 5GHz: setWifi wifi_0/5 falla con "Invalid parameters" → TOLERADO (best-effort).
 *  - PPPoE: reusa credenciales K1 existentes del contrato; si no hay, pre-provisiona
 *    como K1 (PregenInstallPppoe: RADIUS central, nasId null).
 *  - dryRun=true → PLAN completo de calls, CERO llamadas al gateway y CERO side-effects.
 *  - Resultado auditable: bloque "── Aprovisionamiento ONU ──" appendeado a la
 *    descripción de la tarea de instalación del contrato (si existe).
 */
import {
  ProvisionFiberOnu,
  FiberContractLookup,
  FiberContractSnapshot,
  FiberInstallTaskWriter,
} from '@application/use-cases/ProvisionFiberOnu';
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
import type { UnconfiguredOnu } from '@domain/ports/OltProvisioningGateway';
import {
  OnuNotHuaweiError,
  OnuNotAuthorizableError,
  FiberVlanRequiredError,
  UnconfiguredOnuNotFoundError,
  OltProvisioningError,
} from '@domain/errors/smartolt';
import { ContractNotFoundError } from '@domain/errors/contractServices';

const PROFILE = 'IP-FTTH-300';
const SN = 'HWTC11112222';

class FakeContractLookup implements FiberContractLookup {
  contracts = new Map<string, FiberContractSnapshot>();
  async findById(id: string): Promise<FiberContractSnapshot | null> {
    const c = this.contracts.get(id);
    return c ? { ...c } : null;
  }
}

class FakeInstallTaskWriter implements FiberInstallTaskWriter {
  tasks: Array<{ id: string; contractId: string; description: string | null }> = [];
  async findLatestByContract(contractId: string): Promise<{ id: string; description: string | null } | null> {
    const t = [...this.tasks].reverse().find(x => x.contractId === contractId);
    return t ? { id: t.id, description: t.description } : null;
  }
  async updateDescription(taskId: string, description: string): Promise<void> {
    const t = this.tasks.find(x => x.id === taskId);
    if (t) t.description = description;
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
  uc: ProvisionFiberOnu;
  gateway: InMemoryOltProvisioningGateway;
  oltRepo: InMemorySmartOltOltConfigRepository;
  pppoeRepo: InMemoryPppoeServiceRepository;
  orchestrator: InMemoryRadiusOrchestratorGateway;
  contracts: FakeContractLookup;
  taskWriter: FakeInstallTaskWriter;
  ingestConfig: InMemoryGestionRealIngestConfigRepository;
}

async function buildFixture(opts?: { pppoeProfile?: string | null }): Promise<Fixture> {
  const gateway = new InMemoryOltProvisioningGateway();
  gateway.unconfigured = [huaweiOnu()];

  const oltRepo = new InMemorySmartOltOltConfigRepository();
  oltRepo.seed({ id: 'olt-m1', smartoltOltId: '1', name: 'MERCEDES1', serviceVlanDefault: 246, mgmtVlan: 11 });
  oltRepo.seed({ id: 'olt-ch', smartoltOltId: '3', name: 'CHIVILCOY X2', serviceVlanDefault: null, mgmtVlan: null });
  oltRepo.seed({ id: 'olt-es', smartoltOltId: '5', name: 'Estudiantes', serviceVlanDefault: 229, mgmtVlan: 12 });
  oltRepo.seed({ id: 'olt-ag', smartoltOltId: '7', name: 'AGOTE X2', serviceVlanDefault: 331, mgmtVlan: null });

  const contracts = new FakeContractLookup();
  contracts.contracts.set('ctr-1', {
    id: 'ctr-1',
    plan: '300MB',
    grContratoId: '45123',
    clientId: 'cli-1',
    clientName: 'HERNANDEZ RONALD',
    grClienteId: 'gr-cli-1',
  });

  const pppoeRepo = new InMemoryPppoeServiceRepository();
  const orchestrator = new InMemoryRadiusOrchestratorGateway();
  const createPppoe = new CreatePppoeService(
    pppoeRepo,
    new InMemoryRouterGateway(),
    new InMemoryNasRepository(),
    orchestrator,
    new EnsureInternetContractService(
      new InMemoryContractServiceRepository(),
      new InMemoryServiceCatalogRepository(),
    ),
  );
  const pregen = new PregenInstallPppoe(pppoeRepo, createPppoe, new InMemoryGestionRealPort());

  const ingestConfig = new InMemoryGestionRealIngestConfigRepository();
  const profile = opts && 'pppoeProfile' in opts ? opts.pppoeProfile ?? null : PROFILE;
  if (profile) await ingestConfig.update({ pppoeProfile: profile });

  const taskWriter = new FakeInstallTaskWriter();
  taskWriter.tasks.push({
    id: 'task-1',
    contractId: 'ctr-1',
    description: '── Credenciales PPPoE ──\nUsuario: ronaldhernandez45123',
  });

  const uc = new ProvisionFiberOnu(
    gateway,
    oltRepo,
    contracts,
    pppoeRepo,
    pregen,
    ingestConfig,
    taskWriter,
    { rng: () => 0.7 }, // dígitos WiFi determinísticos: 45123 + '777'
  );

  return { uc, gateway, oltRepo, pppoeRepo, orchestrator, contracts, taskWriter, ingestConfig };
}

describe('ProvisionFiberOnu — guards', () => {
  it('sn NO Huawei → OnuNotHuaweiError tipado, CERO llamadas al gateway', async () => {
    const fx = await buildFixture();
    await expect(fx.uc.execute({ contractId: 'ctr-1', onuSn: 'ZTEGC1234567' })).rejects.toThrow(
      OnuNotHuaweiError,
    );
    expect(fx.gateway.calls).toHaveLength(0);
  });

  it('contrato inexistente → ContractNotFoundError, CERO llamadas al gateway', async () => {
    const fx = await buildFixture();
    await expect(fx.uc.execute({ contractId: 'nope', onuSn: SN })).rejects.toThrow(
      ContractNotFoundError,
    );
    expect(fx.gateway.calls).toHaveLength(0);
  });

  it('sn no está en unconfigured_onus → UnconfiguredOnuNotFoundError, sin escrituras', async () => {
    const fx = await buildFixture();
    fx.gateway.unconfigured = [];
    await expect(fx.uc.execute({ contractId: 'ctr-1', onuSn: SN })).rejects.toThrow(
      UnconfiguredOnuNotFoundError,
    );
    expect(fx.gateway.writeSequence()).toEqual([]);
  });
});

describe('ProvisionFiberOnu — VLAN', () => {
  it('CHIVILCOY (sin default) SIN vlan en el input → FiberVlanRequiredError, sin escrituras ni PPPoE', async () => {
    const fx = await buildFixture();
    fx.gateway.unconfigured = [huaweiOnu({ oltId: '3' })];

    await expect(fx.uc.execute({ contractId: 'ctr-1', onuSn: SN })).rejects.toThrow(
      FiberVlanRequiredError,
    );
    expect(fx.gateway.writeSequence()).toEqual([]);
    // La pre-provisión PPPoE NO corrió (el guard de VLAN es previo a todo side-effect).
    expect(await fx.pppoeRepo.findByContract('ctr-1')).toHaveLength(0);
  });

  it('CHIVILCOY CON vlan explícita en el input → autoriza con ESA vlan', async () => {
    const fx = await buildFixture();
    fx.gateway.unconfigured = [huaweiOnu({ oltId: '3' })];

    const result = await fx.uc.execute({ contractId: 'ctr-1', onuSn: SN, vlan: 1500 });

    expect(result.dryRun).toBe(false);
    if (result.dryRun) throw new Error('unreachable');
    expect(result.vlan).toBe(1500);
    const authorize = fx.gateway.calls.find(c => c.method === 'authorizeOnu');
    expect(authorize).toMatchObject({ input: { vlan: 1500, oltId: '3' } });
  });

  it('input.vlan GANA sobre el default del catálogo', async () => {
    const fx = await buildFixture(); // MERCEDES1 default 246
    const result = await fx.uc.execute({ contractId: 'ctr-1', onuSn: SN, vlan: 999 });
    if (result.dryRun) throw new Error('unreachable');
    expect(result.vlan).toBe(999);
  });
});

describe('ProvisionFiberOnu — happy path Huawei (MERCEDES1)', () => {
  it('secuencia completa: authorize → mgmt ip → tr069 → remote wan → wifi 2.4 → wifi 5', async () => {
    const fx = await buildFixture();

    const result = await fx.uc.execute({ contractId: 'ctr-1', onuSn: SN });

    if (result.dryRun) throw new Error('unreachable');
    expect(fx.gateway.writeSequence()).toEqual([
      'authorizeOnu',
      'setMgmtIp',
      'enableTr069',
      'allowRemoteWanAccess',
      'setWifi:wifi_0/1',
      'setWifi:wifi_0/5',
    ]);
    expect(result.steps).toEqual([
      { step: 'authorize', status: 'ok' },
      { step: 'mgmt_ip', status: 'ok' },
      { step: 'tr069', status: 'ok' },
      { step: 'remote_wan', status: 'ok' },
      { step: 'wifi_24', status: 'ok' },
      { step: 'wifi_5', status: 'ok' },
    ]);
  });

  it('authorize viaja con los datos de la ONU + VLAN default + speed profiles derivados del plan', async () => {
    const fx = await buildFixture();

    const result = await fx.uc.execute({ contractId: 'ctr-1', onuSn: SN });

    if (result.dryRun) throw new Error('unreachable');
    expect(result.vlan).toBe(246);
    expect(result.olt).toEqual({ smartoltOltId: '1', name: 'MERCEDES1' });
    const authorize = fx.gateway.calls.find(c => c.method === 'authorizeOnu');
    expect(authorize).toEqual({
      method: 'authorizeOnu',
      input: {
        sn: SN,
        oltId: '1',
        ponType: 'gpon',
        board: '0',
        port: '3',
        onuTypeName: 'HG8546M',
        vlan: 246,
        name: 'HERNANDEZ RONALD [45123]',
        downloadSpeedProfileName: '300M',
        uploadSpeedProfileName: '300M',
      },
    });
  });

  it('mgmt ip con la VLAN de management del catálogo (MERCEDES1 → 11) y tr069 con profile SmartOLT', async () => {
    const fx = await buildFixture();

    await fx.uc.execute({ contractId: 'ctr-1', onuSn: SN });

    expect(fx.gateway.calls).toContainEqual({ method: 'setMgmtIp', sn: SN, vlan: 11 });
    expect(fx.gateway.calls).toContainEqual({ method: 'enableTr069', sn: SN, profile: 'SmartOLT' });
    expect(fx.gateway.calls).toContainEqual({ method: 'allowRemoteWanAccess', sn: SN });
  });

  it('WiFi: SSIDs IPNEXT_<APELLIDO>_{2.4,5} + clave contrato+random(8) en AMBAS bandas', async () => {
    const fx = await buildFixture();

    const result = await fx.uc.execute({ contractId: 'ctr-1', onuSn: SN });

    if (result.dryRun) throw new Error('unreachable');
    expect(result.wifi).toEqual({
      ssid24: 'IPNEXT_HERNANDEZ_2.4',
      ssid5: 'IPNEXT_HERNANDEZ_5',
      password: '45123777',
    });
    expect(fx.gateway.calls).toContainEqual({
      method: 'setWifi',
      sn: SN,
      input: { port: 'wifi_0/1', ssid: 'IPNEXT_HERNANDEZ_2.4', password: '45123777' },
    });
    expect(fx.gateway.calls).toContainEqual({
      method: 'setWifi',
      sn: SN,
      input: { port: 'wifi_0/5', ssid: 'IPNEXT_HERNANDEZ_5', password: '45123777' },
    });
  });

  it('FIX H2: OLT sin mgmtVlan (AGOTE) → mgmt_ip SALTADO y TODA la cadena dependiente también (SmartOLT exige mgmt→tr069→wifi)', async () => {
    const fx = await buildFixture();
    fx.gateway.unconfigured = [huaweiOnu({ oltId: '7' })];

    const result = await fx.uc.execute({ contractId: 'ctr-1', onuSn: SN });

    if (result.dryRun) throw new Error('unreachable');
    expect(result.vlan).toBe(331);
    // SOLO authorize tocó SmartOLT: nada de quemar rate limit en pasos que van a fallar.
    expect(fx.gateway.writeSequence()).toEqual(['authorizeOnu']);
    expect(result.steps.find(s => s.step === 'mgmt_ip')).toMatchObject({ status: 'skipped' });
    for (const step of ['tr069', 'remote_wan', 'wifi_24', 'wifi_5'] as const) {
      expect(result.steps.find(s => s.step === step)).toEqual({
        step,
        status: 'skipped',
        detail: 'requiere MGMT IP (mgmtVlan no configurada para esta OLT)',
      });
    }
  });

  it('FIX H1: plan sin velocidad derivable → authorize SIN speed profiles + detail que lo dice', async () => {
    const fx = await buildFixture();
    fx.contracts.contracts.set('ctr-1', {
      ...fx.contracts.contracts.get('ctr-1')!,
      plan: 'CORPORATIVO PROMO 2X1',
    });

    const result = await fx.uc.execute({ contractId: 'ctr-1', onuSn: SN });

    if (result.dryRun) throw new Error('unreachable');
    const authorize = fx.gateway.calls.find(c => c.method === 'authorizeOnu');
    expect(authorize).toMatchObject({
      input: { downloadSpeedProfileName: null, uploadSpeedProfileName: null },
    });
    expect(result.steps.find(s => s.step === 'authorize')).toEqual({
      step: 'authorize',
      status: 'ok',
      detail: 'sin speed profiles (plan "CORPORATIVO PROMO 2X1" no derivable) — ajustar a mano en SmartOLT',
    });
  });
});

describe('ProvisionFiberOnu — 5GHz best-effort (gotcha SmartOLT)', () => {
  it('setWifi wifi_0/5 falla ("Invalid parameters") → paso wifi_5 failed, flujo NO aborta', async () => {
    const fx = await buildFixture();
    fx.gateway.failWifiPorts = ['wifi_0/5'];

    const result = await fx.uc.execute({ contractId: 'ctr-1', onuSn: SN });

    if (result.dryRun) throw new Error('unreachable');
    expect(result.steps.find(s => s.step === 'wifi_5')).toEqual({
      step: 'wifi_5',
      status: 'failed',
      detail: 'Invalid parameters',
    });
    // El resto de los pasos completó OK.
    expect(result.steps.filter(s => s.status === 'ok').map(s => s.step)).toEqual([
      'authorize',
      'mgmt_ip',
      'tr069',
      'remote_wan',
      'wifi_24',
    ]);
    // El resultado sigue siendo auditable en la tarea.
    expect(result.taskUpdated).toBe(true);
  });

  it('authorize falla → propaga OltProvisioningError y NO ejecuta pasos posteriores', async () => {
    const fx = await buildFixture();
    fx.gateway.failMethods = ['authorizeOnu'];

    await expect(fx.uc.execute({ contractId: 'ctr-1', onuSn: SN })).rejects.toThrow(
      OltProvisioningError,
    );
    expect(fx.gateway.writeSequence()).toEqual([]);
  });

  it('FIX H2: tr069 falla → los WIFIs se SALTAN (dependen de TR-069); remote_wan sí corre', async () => {
    const fx = await buildFixture();
    fx.gateway.failMethods = ['enableTr069'];

    const result = await fx.uc.execute({ contractId: 'ctr-1', onuSn: SN });

    if (result.dryRun) throw new Error('unreachable');
    expect(result.steps.find(s => s.step === 'tr069')).toMatchObject({ status: 'failed' });
    for (const step of ['wifi_24', 'wifi_5'] as const) {
      expect(result.steps.find(s => s.step === step)).toEqual({
        step,
        status: 'skipped',
        detail: 'requiere TR-069 (el paso tr069 no completó)',
      });
    }
    expect(fx.gateway.writeSequence()).toEqual([
      'authorizeOnu',
      'setMgmtIp',
      'allowRemoteWanAccess',
    ]);
  });

  it('FIX H2: mgmt_ip FALLA → tr069/remote_wan/wifis se SALTAN con el motivo', async () => {
    const fx = await buildFixture();
    fx.gateway.failMethods = ['setMgmtIp'];

    const result = await fx.uc.execute({ contractId: 'ctr-1', onuSn: SN });

    if (result.dryRun) throw new Error('unreachable');
    expect(result.steps.find(s => s.step === 'mgmt_ip')).toMatchObject({ status: 'failed' });
    for (const step of ['tr069', 'remote_wan', 'wifi_24', 'wifi_5'] as const) {
      expect(result.steps.find(s => s.step === step)).toEqual({
        step,
        status: 'skipped',
        detail: 'requiere MGMT IP (el paso mgmt_ip no completó)',
      });
    }
    expect(fx.gateway.writeSequence()).toEqual(['authorizeOnu']);
  });
});

describe('ProvisionFiberOnu — PPPoE (K1)', () => {
  it('contrato SIN PPPoE → pre-provisiona como K1 (RADIUS central, nasId null) con credenciales determinísticas', async () => {
    const fx = await buildFixture();

    const result = await fx.uc.execute({ contractId: 'ctr-1', onuSn: SN });

    if (result.dryRun) throw new Error('unreachable');
    // FIX H3: created viaja CON la clave (recién generada, legítima) — el FE la muestra.
    expect(result.pppoe).toEqual({
      status: 'created',
      username: 'ronaldhernandez45123',
      password: 'ronald1234',
    });
    const row = await fx.pppoeRepo.findByUsername('ronaldhernandez45123');
    expect(row).toMatchObject({ contractId: 'ctr-1', nasId: null, profile: PROFILE, status: 'enabled' });
    expect(fx.orchestrator.createdUser('ronaldhernandez45123')).toMatchObject({
      plan: PROFILE,
      framedIp: null,
    });
  });

  it('contrato CON PPPoE enabled (K1 previo) → REUSA: existing, sin alta nueva en el RADIUS', async () => {
    const fx = await buildFixture();
    await fx.pppoeRepo.upsertByUsername({
      username: 'usuario-k1',
      password: 'p',
      profile: PROFILE,
      nasId: null,
      contractId: 'ctr-1',
      status: 'enabled',
    });

    const result = await fx.uc.execute({ contractId: 'ctr-1', onuSn: SN });

    if (result.dryRun) throw new Error('unreachable');
    expect(result.pppoe).toEqual({ status: 'existing', username: 'usuario-k1' });
    expect(await fx.pppoeRepo.findByContract('ctr-1')).toHaveLength(1);
    expect(fx.orchestrator.createdUser('ronaldhernandez45123')).toBeUndefined();
  });

  it('FIX H3: contrato con PPPoE PENDING (pregen previo fallido) → stale CON reason propagado, jamás aplanado', async () => {
    const fx = await buildFixture();
    await fx.pppoeRepo.upsertByUsername({
      username: 'pendiente-viejo',
      password: 'clave-muerta',
      profile: PROFILE,
      nasId: null,
      contractId: 'ctr-1',
      status: 'pending',
    });

    const result = await fx.uc.execute({ contractId: 'ctr-1', onuSn: SN });

    if (result.dryRun) throw new Error('unreachable');
    expect(result.pppoe).toEqual({ status: 'stale', username: 'pendiente-viejo', reason: 'pending' });
    // JAMÁS la clave de una fila stale en el response ni en la tarea (está muerta).
    expect(JSON.stringify(result)).not.toContain('clave-muerta');
  });

  it('FIX LOW-d (pin): authorize falla DESPUÉS del pregen → el PPPoE pre-provisionado SOBREVIVE (semántica K1) y el retry lo reusa como existing', async () => {
    const fx = await buildFixture();
    fx.gateway.failMethods = ['authorizeOnu'];

    await expect(fx.uc.execute({ contractId: 'ctr-1', onuSn: SN })).rejects.toThrow(
      OltProvisioningError,
    );
    // La pre-provisión K1 es DURABLE: el usuario ya vive en el RADIUS central con su
    // clave legítima — borrarla dejaría un fantasma. El retry la reusa, no la duplica.
    const row = await fx.pppoeRepo.findByUsername('ronaldhernandez45123');
    expect(row).toMatchObject({ contractId: 'ctr-1', status: 'enabled', nasId: null });

    fx.gateway.failMethods = [];
    const retry = await fx.uc.execute({ contractId: 'ctr-1', onuSn: SN });
    if (retry.dryRun) throw new Error('unreachable');
    expect(retry.pppoe).toEqual({ status: 'existing', username: 'ronaldhernandez45123' });
    expect(await fx.pppoeRepo.findByContract('ctr-1')).toHaveLength(1);
  });

  it('pppoeProfile NO configurado → pppoe skipped, el aprovisionamiento de la ONU sigue', async () => {
    const fx = await buildFixture({ pppoeProfile: null });

    const result = await fx.uc.execute({ contractId: 'ctr-1', onuSn: SN });

    if (result.dryRun) throw new Error('unreachable');
    expect(result.pppoe).toEqual({ status: 'skipped' });
    expect(await fx.pppoeRepo.findByContract('ctr-1')).toHaveLength(0);
    expect(result.steps.find(s => s.step === 'authorize')).toMatchObject({ status: 'ok' });
  });
});

describe('ProvisionFiberOnu — dryRun (plan sin calls)', () => {
  it('devuelve el PLAN completo y NO llama al gateway ni genera side-effects', async () => {
    const fx = await buildFixture();

    const result = await fx.uc.execute({ contractId: 'ctr-1', onuSn: SN, vlan: 246, dryRun: true });

    expect(result.dryRun).toBe(true);
    if (!result.dryRun) throw new Error('unreachable');
    // CERO llamadas al gateway (regla dura del K2: el dry-run no toca SmartOLT).
    expect(fx.gateway.calls).toHaveLength(0);
    // CERO side-effects: ni PPPoE ni tarea tocada.
    expect(await fx.pppoeRepo.findByContract('ctr-1')).toHaveLength(0);
    expect(fx.taskWriter.tasks[0]!.description).toBe(
      '── Credenciales PPPoE ──\nUsuario: ronaldhernandez45123',
    );
    // El plan enumera los calls que haría, en orden.
    expect(result.plan.map(p => p.call)).toEqual([
      'GET onu/unconfigured_onus',
      'POST onu/authorize_onu',
      'POST onu/set_onu_mgmt_ip_static_ip/<sn>',
      'POST onu/enable_tr069/<sn>',
      'POST onu/enable_allow_remote_access_to_wan_ip/<sn>',
      'POST onu/set_wifi_port_lan/<sn> (2.4GHz)',
      'POST onu/set_wifi_port_lan/<sn> (5GHz)',
    ]);
    expect(result.vlan).toBe(246);
    expect(result.wifi.ssid24).toBe('IPNEXT_HERNANDEZ_2.4');
    // Sin PPPoE previo → el plan anuncia la generación determinística K1.
    expect(result.pppoe).toEqual({ action: 'generate', username: 'ronaldhernandez45123' });
  });

  it('dryRun SIN vlan → vlan null (se resuelve del catálogo al ejecutar), sin error', async () => {
    const fx = await buildFixture();

    const result = await fx.uc.execute({ contractId: 'ctr-1', onuSn: SN, dryRun: true });

    if (!result.dryRun) throw new Error('unreachable');
    expect(result.vlan).toBeNull();
    expect(fx.gateway.calls).toHaveLength(0);
  });

  it('dryRun con PPPoE enabled existente → anuncia reuse-existing con ese username', async () => {
    const fx = await buildFixture();
    await fx.pppoeRepo.upsertByUsername({
      username: 'usuario-k1',
      password: 'p',
      profile: PROFILE,
      nasId: null,
      contractId: 'ctr-1',
      status: 'enabled',
    });

    const result = await fx.uc.execute({ contractId: 'ctr-1', onuSn: SN, dryRun: true });

    if (!result.dryRun) throw new Error('unreachable');
    expect(result.pppoe).toEqual({ action: 'reuse-existing', username: 'usuario-k1' });
  });

  it('dryRun también valida el guard Huawei (rechaza otro vendor)', async () => {
    const fx = await buildFixture();
    await expect(
      fx.uc.execute({ contractId: 'ctr-1', onuSn: 'ZTEGC1234567', dryRun: true }),
    ).rejects.toThrow(OnuNotHuaweiError);
  });

  it('FIX M1: el dry-run NO muestra una clave WiFi que no va a ser — placeholder explícito', async () => {
    const fx = await buildFixture();

    const result = await fx.uc.execute({ contractId: 'ctr-1', onuSn: SN, dryRun: true });

    if (!result.dryRun) throw new Error('unreachable');
    // La clave real se sortea EN LA EJECUCIÓN; mostrar un sorteo acá haría que el
    // operador apruebe una clave X y la ONU quede con Y.
    expect(result.wifi.password).toBe('(se genera al ejecutar)');
    const wifiCalls = result.plan.filter(p => p.call.includes('set_wifi_port_lan'));
    expect(wifiCalls).toHaveLength(2);
    for (const call of wifiCalls) {
      expect(call.params['password']).toBe('(se genera al ejecutar)');
    }
    // Los SSIDs sí son definitivos (derivación determinística del cliente).
    expect(result.wifi.ssid24).toBe('IPNEXT_HERNANDEZ_2.4');
  });
});

describe('ProvisionFiberOnu — guards de la ONU (fix wave LOWs)', () => {
  it('FIX LOW-a: ONU detectada pero SIN acción authorize → error tipado local, sin quemar el call', async () => {
    const fx = await buildFixture();
    fx.gateway.unconfigured = [huaweiOnu({ supportsAuthorize: false })];

    await expect(fx.uc.execute({ contractId: 'ctr-1', onuSn: SN })).rejects.toThrow(
      OnuNotAuthorizableError,
    );
    expect(fx.gateway.writeSequence()).toEqual([]);
    // Tampoco corrió la pre-provisión PPPoE (guard previo a todo side-effect).
    expect(await fx.pppoeRepo.findByContract('ctr-1')).toHaveLength(0);
  });

  it('FIX LOW-b: sn en minúsculas matchea case-insensitive y las calls usan el SN CANÓNICO de SmartOLT', async () => {
    const fx = await buildFixture();

    const result = await fx.uc.execute({ contractId: 'ctr-1', onuSn: 'hwtc11112222' });

    if (result.dryRun) throw new Error('unreachable');
    expect(result.onuSn).toBe(SN);
    const authorize = fx.gateway.calls.find(c => c.method === 'authorizeOnu');
    expect(authorize).toMatchObject({ input: { sn: SN } });
    expect(fx.gateway.calls).toContainEqual({ method: 'enableTr069', sn: SN, profile: 'SmartOLT' });
  });
});

describe('ProvisionFiberOnu — resultado auditable en la tarea', () => {
  it('appendea el bloque "── Aprovisionamiento ONU ──" PRESERVANDO la descripción previa (K1)', async () => {
    const fx = await buildFixture();

    const result = await fx.uc.execute({ contractId: 'ctr-1', onuSn: SN });

    if (result.dryRun) throw new Error('unreachable');
    expect(result.taskUpdated).toBe(true);
    const description = fx.taskWriter.tasks[0]!.description!;
    // El bloque K1 previo sobrevive.
    expect(description).toContain('── Credenciales PPPoE ──');
    // Y el bloque nuevo llega completo: sn, OLT+VLAN, WiFi ssid/clave y estado por paso.
    expect(description).toContain('── Aprovisionamiento ONU ──');
    expect(description).toContain(`SN: ${SN}`);
    expect(description).toContain('OLT: MERCEDES1 · VLAN 246');
    expect(description).toContain('WiFi 2.4: IPNEXT_HERNANDEZ_2.4');
    expect(description).toContain('WiFi 5: IPNEXT_HERNANDEZ_5');
    expect(description).toContain('Clave WiFi: 45123777');
    expect(description).toContain('authorize ✓');
  });

  it('FIX H3: created → el bloque incluye la sección PPPoE de K1 con Usuario+Clave+estado', async () => {
    const fx = await buildFixture();

    await fx.uc.execute({ contractId: 'ctr-1', onuSn: SN });

    const description = fx.taskWriter.tasks[0]!.description!;
    // Reusa renderPppoeCredentialsBlock (K1): el instalador ve la clave EN LA TAREA
    // (pedido explícito del usuario — no es un leak accidental).
    expect(description).toContain(
      '── Credenciales PPPoE ──\n' +
        'Usuario: ronaldhernandez45123\n' +
        'Clave: ronald1234\n' +
        'Estado: pendiente de instalar',
    );
  });

  it('FIX H3: existing → sección PPPoE "(ya existente)" SIN la clave (no se conoce)', async () => {
    const fx = await buildFixture();
    await fx.pppoeRepo.upsertByUsername({
      username: 'usuario-k1',
      password: 'clave-secreta-vieja',
      profile: PROFILE,
      nasId: null,
      contractId: 'ctr-1',
      status: 'enabled',
    });

    await fx.uc.execute({ contractId: 'ctr-1', onuSn: SN });

    const description = fx.taskWriter.tasks[0]!.description!;
    expect(description).toContain('Usuario: usuario-k1 (ya existente)');
    expect(description).not.toContain('clave-secreta-vieja');
  });

  it('FIX H3: stale → sección PPPoE con la advertencia ⚠ POR REASON, sin clave', async () => {
    const fx = await buildFixture();
    await fx.pppoeRepo.upsertByUsername({
      username: 'pendiente-viejo',
      password: 'clave-muerta',
      profile: PROFILE,
      nasId: null,
      contractId: 'ctr-1',
      status: 'pending',
    });

    await fx.uc.execute({ contractId: 'ctr-1', onuSn: SN });

    const description = fx.taskWriter.tasks[0]!.description!;
    expect(description).toContain('Usuario: pendiente-viejo');
    expect(description).toContain(
      '⚠ Aprovisionamiento previo PENDIENTE (no llegó al RADIUS) — reintentar desde la página PPPoE',
    );
    expect(description).not.toContain('clave-muerta');
  });

  it('el bloque refleja pasos fallidos (wifi_5 ✗ con el detalle)', async () => {
    const fx = await buildFixture();
    fx.gateway.failWifiPorts = ['wifi_0/5'];

    await fx.uc.execute({ contractId: 'ctr-1', onuSn: SN });

    const description = fx.taskWriter.tasks[0]!.description!;
    expect(description).toContain('wifi_5 ✗ (Invalid parameters)');
  });

  it('contrato sin tarea → taskUpdated false, sin throw', async () => {
    const fx = await buildFixture();
    fx.taskWriter.tasks = [];

    const result = await fx.uc.execute({ contractId: 'ctr-1', onuSn: SN });

    if (result.dryRun) throw new Error('unreachable');
    expect(result.taskUpdated).toBe(false);
    expect(result.steps.find(s => s.step === 'authorize')).toMatchObject({ status: 'ok' });
  });
});
