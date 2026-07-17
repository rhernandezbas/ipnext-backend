import {
  OltProvisioningGateway,
  UnconfiguredOnu,
} from '@domain/ports/OltProvisioningGateway';
import { SmartOltOltConfigRepository, SmartOltOltConfig } from '@domain/ports/SmartOltOltConfigRepository';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { GestionRealIngestConfigRepository } from '@domain/ports/GestionRealIngestConfigRepository';
import {
  isHuaweiSn,
  deriveWifiSsids,
  deriveWifiPassword,
  deriveSpeedProfileNames,
} from '@domain/services/fiberProvisioning';
import { generatePppoeCredentials } from '@domain/services/pppoeCredentials';
import {
  OnuNotHuaweiError,
  OnuNotAuthorizableError,
  FiberVlanRequiredError,
  UnconfiguredOnuNotFoundError,
} from '@domain/errors/smartolt';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import {
  PregenInstallPppoe,
  PregenInstallPppoeOutcome,
  PregenStaleReason,
  renderPppoeCredentialsBlock,
} from './PregenInstallPppoe';

/** Profile TR-069 default de la instancia IPNEXT (verificado en la skill smartolt). */
const DEFAULT_TR069_PROFILE = 'SmartOLT';

/** Header del bloque de auditoría en la descripción de la tarea (espejo del K1). */
const BLOCK_HEADER = '── Aprovisionamiento ONU ──';

/**
 * Fix M1: la clave WiFi real se sortea AL EJECUTAR (RNG). El dry-run mostraba
 * un sorteo propio → el operador aprobaba una clave X y la ONU quedaba con Y.
 * El plan lleva este placeholder explícito, nunca una clave que no va a ser.
 */
const DRY_RUN_WIFI_PASSWORD_PLACEHOLDER = '(se genera al ejecutar)';

/** Proyección del contrato que necesita el aprovisionamiento (cliente + plan + ids GR). */
export interface FiberContractSnapshot {
  id: string;
  plan: string;
  grContratoId: string | null;
  clientId: string;
  clientName: string;
  grClienteId: string | null;
}

/** Lookup del contrato — implementado inline con Prisma en app.ts (precedente prismaContractClientNameLookup). */
export interface FiberContractLookup {
  findById(id: string): Promise<FiberContractSnapshot | null>;
}

/**
 * Escritor del resultado auditable: la tarea de instalación del contrato.
 * `findLatestByContract` = última tarea NO archivada del contrato (la creada por
 * el ingest K1 típicamente). Best-effort: si no hay tarea, no pasa nada.
 */
export interface FiberInstallTaskWriter {
  findLatestByContract(contractId: string): Promise<{ id: string; description: string | null } | null>;
  /**
   * K3 fix wave M4 — lookup directo por id: el watcher CONOCE la tarea matcheada
   * por serial y audita AHÍ (no en "la última del contrato", que puede ser un
   * reclamo posterior). El wizard sigue usando findLatestByContract.
   */
  findById(taskId: string): Promise<{ id: string; description: string | null } | null>;
  updateDescription(taskId: string, description: string): Promise<void>;
}

export interface ProvisionFiberOnuInput {
  contractId: string;
  onuSn: string;
  /** VLAN de servicio explícita — gana sobre el default del catálogo. */
  vlan?: number;
  /** true → NO llama al gateway: devuelve el PLAN de calls para aprobación. */
  dryRun?: boolean;
  /**
   * K3 (fiber-auto-watcher) — origen del aprovisionamiento. 'watcher' agrega la
   * línea "(aprovisionada AUTOMÁTICAMENTE por el watcher)" al bloque auditable
   * de la tarea. Ausente/'manual' = bloque K2 intacto (botón del wizard).
   */
  origin?: 'manual' | 'watcher';
  /**
   * K3 fix wave M4 — override del destino del bloque auditable: el watcher pasa
   * la tarea MATCHEADA por serial. Ausente = semántica K2 (última tarea no
   * archivada del contrato).
   */
  auditTaskId?: string;
}

export type ProvisionStepName =
  | 'authorize'
  | 'mgmt_ip'
  | 'tr069'
  | 'remote_wan'
  | 'wifi_24'
  | 'wifi_5';

export interface ProvisionStepResult {
  step: ProvisionStepName;
  status: 'ok' | 'failed' | 'skipped';
  detail?: string;
}

/**
 * Resumen del lado PPPoE (K1) del aprovisionamiento:
 *  - created  → credenciales NUEVAS: viaja CON la clave (recién generada, legítima —
 *               el FE la muestra y la tarea la lleva; pedido explícito del usuario).
 *  - existing → username sin clave (no se conoce: solo el RADIUS la tiene).
 *  - stale    → username + `reason` tipado del K1 (disabled/pending/radius-desync) —
 *               fix H3: el reason NO se aplana, el FE muestra la advertencia correcta.
 *               JAMÁS la clave (está muerta / no es la real).
 *  - failed   → la pre-provisión explotó (orchestrator caído, etc.) — no aborta la ONU.
 *  - skipped  → sin `pppoeProfile` configurado o contrato sin número GR: no se puede
 *               pre-provisionar; si el contrato ya tenía un PPPoE enabled se reporta existing.
 */
export type FiberPppoeSummary =
  | { status: 'created'; username: string; password: string }
  | { status: 'existing'; username: string }
  | { status: 'stale'; username: string; reason: PregenStaleReason }
  | { status: 'failed' | 'skipped' };

/** Mapea el resumen fiber al outcome K1 para reusar SU renderer (fix H3). */
function toPregenOutcome(pppoe: FiberPppoeSummary): PregenInstallPppoeOutcome | null {
  switch (pppoe.status) {
    case 'created':
      return { status: 'created', username: pppoe.username, password: pppoe.password };
    case 'existing':
      return { status: 'existing', username: pppoe.username };
    case 'stale':
      return { status: 'stale', username: pppoe.username, reason: pppoe.reason };
    default:
      return null; // failed/skipped: no hay credenciales que mostrar (semántica K1 'failed').
  }
}

export interface PlannedCall {
  call: string;
  params: Record<string, unknown>;
}

export interface WifiPlanView {
  ssid24: string;
  ssid5: string;
  password: string;
}

export interface ProvisionFiberOnuExecuted {
  dryRun: false;
  contractId: string;
  onuSn: string;
  olt: { smartoltOltId: string; name: string | null };
  vlan: number;
  wifi: WifiPlanView;
  pppoe: FiberPppoeSummary;
  steps: ProvisionStepResult[];
  taskUpdated: boolean;
}

export interface ProvisionFiberOnuPlan {
  dryRun: true;
  contractId: string;
  onuSn: string;
  /** null = sin vlan en el input: se resuelve del catálogo del OLT AL EJECUTAR. */
  vlan: number | null;
  wifi: WifiPlanView;
  /** Qué haría el lado PPPoE: reusar el K1 existente o generar credenciales nuevas. */
  pppoe: { action: 'reuse-existing' | 'review-stale' | 'generate'; username: string };
  plan: PlannedCall[];
}

export type ProvisionFiberOnuResult = ProvisionFiberOnuExecuted | ProvisionFiberOnuPlan;

const STEP_SYMBOLS: Record<ProvisionStepResult['status'], string> = {
  ok: '✓',
  failed: '✗',
  skipped: '—',
};

/**
 * Bloque de texto auditable que se appendea a la descripción de la tarea de
 * instalación: el instalador ve sn, OLT/VLAN, credenciales WiFi, el estado por
 * paso y — fix H3 — la sección PPPoE REUSANDO `renderPppoeCredentialsBlock` de
 * K1 (created → Usuario+Clave+estado; existing → "(ya existente)" sin clave;
 * stale → la advertencia ⚠ por reason; failed/skipped → sin sección).
 */
export function renderOnuProvisioningBlock(params: {
  sn: string;
  oltLabel: string;
  vlan: number;
  wifi: WifiPlanView;
  pppoe: FiberPppoeSummary;
  steps: ProvisionStepResult[];
  /** K3 — 'watcher' agrega la línea de origen automático; ausente/'manual' = bloque K2 intacto. */
  origin?: 'manual' | 'watcher';
}): string {
  const pasos = params.steps
    .map(s => `${s.step} ${STEP_SYMBOLS[s.status]}${s.detail ? ` (${s.detail})` : ''}`)
    .join(' · ');
  let block =
    `${BLOCK_HEADER}\n` +
    `SN: ${params.sn}\n` +
    `OLT: ${params.oltLabel} · VLAN ${params.vlan}\n` +
    `WiFi 2.4: ${params.wifi.ssid24}\n` +
    `WiFi 5: ${params.wifi.ssid5}\n` +
    `Clave WiFi: ${params.wifi.password}\n` +
    `Pasos: ${pasos}`;
  // K3 — el instalador tiene que poder distinguir un auto-aprovisionamiento del botón.
  if (params.origin === 'watcher') block += '\n(aprovisionada AUTOMÁTICAMENTE por el watcher)';
  const pregenOutcome = toPregenOutcome(params.pppoe);
  const pppoeBlock = pregenOutcome ? renderPppoeCredentialsBlock(pregenOutcome) : null;
  if (pppoeBlock) block += `\n${pppoeBlock}`;
  return block;
}

/**
 * smartolt-provision (K2) — aprovisionamiento automático de una ONU fibra
 * Huawei vía SmartOLT, botón-driven (SIN cron).
 *
 * Flujo (dryRun=false):
 *  1. Guard Huawei: solo sn HWTC (OnuNotHuaweiError).
 *  2. Resuelve el contrato (cliente/plan/ids GR) — ContractNotFoundError.
 *  3. Busca la ONU en unconfigured_onus (UnconfiguredOnuNotFoundError si no está).
 *  4. VLAN = input.vlan ?? serviceVlanDefault del catálogo del OLT; sin ninguna →
 *     FiberVlanRequiredError (CHIVILCOY: el operador la elige SIEMPRE).
 *  5. PPPoE: reusa las credenciales K1 del contrato o pre-provisiona como K1
 *     (PregenInstallPppoe — nunca throw, outcome tipado). Requiere pppoeProfile
 *     configurado + grContratoId; si faltan → 'skipped' (la ONU se aprovisiona igual).
 *  6. Secuencia SmartOLT: authorize → mgmt ip → tr069 → remote wan → wifi 2.4 → wifi 5.
 *     - authorize falla → ABORTA (nada quedó aprovisionado; el error tipado llega a la ruta).
 *     - Fix H2 — DEPENDENCIA DURA de SmartOLT (skill smartolt-ipnext): tr069 exige
 *       la MGMT IP previa, y los wifi exigen tr069. mgmt_ip no-ok (skipped por
 *       mgmtVlan null — CHIVILCOY/AGOTE — o failed) → tr069/remote_wan/wifi_24/
 *       wifi_5 se SALTAN con el motivo (no se quema rate limit en calls que van a
 *       fallar sí o sí). tr069 no-ok → los wifi se saltan igual.
 *     - Pasos dependientes que SÍ corren y fallan → best-effort: 'failed' y se
 *       sigue (la ONU ya está autorizada; abortar dejaría peor estado).
 *       Gotcha 5GHz: wifi_0/5 no existe para los tipos Huawei de IPNEXT en SmartOLT
 *       → falla con "Invalid parameters" SIEMPRE, tolerada por diseño.
 *  7. Auditoría: appendea el bloque "── Aprovisionamiento ONU ──" (incl. la sección
 *     PPPoE de K1, fix H3) a la descripción de la última tarea del contrato
 *     (best-effort — sin tarea no es error).
 *
 * Orphan PPPoE (fix LOW-d, semántica PINEADA por test): si el authorize falla
 * DESPUÉS de la pre-provisión (paso 5), el PPPoE creado SOBREVIVE a propósito —
 * es la semántica K1: el usuario ya vive en el RADIUS central con su clave
 * legítima; borrarlo dejaría un fantasma en el RADIUS. El retry del
 * aprovisionamiento lo reusa como 'existing' (jamás duplica).
 *
 * dryRun=true → CERO llamadas al gateway y CERO side-effects (ni PPPoE ni tarea):
 * devuelve el PLAN de calls que haría, para que el usuario lo apruebe. Nota: sin
 * el gateway no se conoce el OLT de la ONU, así que la VLAN default y el board/port
 * quedan "a resolver al ejecutar" cuando el input no trae vlan. La clave WiFi del
 * plan es un placeholder (fix M1): la real se sortea al ejecutar.
 */
export class ProvisionFiberOnu {
  private readonly rng: () => number;
  private readonly tr069Profile: string;

  constructor(
    private readonly gateway: OltProvisioningGateway,
    private readonly oltConfigRepo: SmartOltOltConfigRepository,
    private readonly contractLookup: FiberContractLookup,
    private readonly pppoeRepo: PppoeServiceRepository,
    private readonly pregenPppoe: PregenInstallPppoe,
    private readonly ingestConfigRepo: GestionRealIngestConfigRepository,
    private readonly taskWriter: FiberInstallTaskWriter,
    opts?: { rng?: () => number; tr069Profile?: string },
  ) {
    this.rng = opts?.rng ?? Math.random;
    this.tr069Profile = opts?.tr069Profile ?? DEFAULT_TR069_PROFILE;
  }

  async execute(input: ProvisionFiberOnuInput): Promise<ProvisionFiberOnuResult> {
    // 1. Solo Huawei se auto-aprovisiona (guard previo a CUALQUIER I/O).
    if (!isHuaweiSn(input.onuSn)) throw new OnuNotHuaweiError(input.onuSn);

    // 2. Contrato → cliente/plan/ids GR.
    const contract = await this.contractLookup.findById(input.contractId);
    if (!contract) throw new ContractNotFoundError(input.contractId);

    // Derivaciones puras: SSIDs y speed profiles (la clave WiFi se sortea SOLO al ejecutar).
    const ssids = deriveWifiSsids(contract.clientName);
    const speed = deriveSpeedProfileNames(contract.plan);

    if (input.dryRun) {
      // Fix M1: el plan JAMÁS muestra una clave que no va a ser — placeholder honesto.
      const planWifi: WifiPlanView = { ...ssids, password: DRY_RUN_WIFI_PASSWORD_PLACEHOLDER };
      return this.buildPlan(input, contract, planWifi, speed);
    }

    const wifi: WifiPlanView = {
      ...ssids,
      password: deriveWifiPassword(contract.grContratoId, this.rng),
    };

    // 3. La ONU tiene que estar detectada y sin configurar. Fix LOW-b: el match de
    //    SN es case-insensitive y de acá en más manda el SN CANÓNICO de SmartOLT.
    const onus = await this.gateway.listUnconfiguredOnus();
    const wantedSn = input.onuSn.toUpperCase();
    const onu = onus.find(o => o.sn.toUpperCase() === wantedSn);
    if (!onu) throw new UnconfiguredOnuNotFoundError(input.onuSn);
    // Fix LOW-a: SmartOLT no ofrece authorize para esta ONU → rechazo local tipado,
    // sin quemar un call del rate limit que va a fallar sí o sí.
    if (!onu.supportsAuthorize) throw new OnuNotAuthorizableError(onu.sn);

    // 4. VLAN de servicio: input > default del catálogo > error tipado.
    const oltCfg = await this.oltConfigRepo.findBySmartoltOltId(onu.oltId);
    const vlan = input.vlan ?? oltCfg?.serviceVlanDefault ?? null;
    if (vlan === null) throw new FiberVlanRequiredError(onu.oltId);

    // 5. PPPoE (K1): reusar o pre-provisionar. Nunca aborta la ONU.
    const pppoe = await this.ensurePppoe(contract);

    // 6. Secuencia SmartOLT.
    const steps = await this.runSequence(onu, oltCfg, vlan, wifi, speed, contract);

    // 7. Resultado auditable en la tarea de instalación (best-effort).
    const oltLabel = oltCfg?.name ?? onu.oltId;
    const taskUpdated = await this.appendToInstallTask(contract.id, {
      sn: onu.sn,
      oltLabel,
      vlan,
      wifi,
      pppoe,
      steps,
      origin: input.origin,
    }, input.auditTaskId);

    return {
      dryRun: false,
      contractId: contract.id,
      onuSn: onu.sn,
      olt: { smartoltOltId: onu.oltId, name: oltCfg?.name ?? null },
      vlan,
      wifi,
      pppoe,
      steps,
      taskUpdated,
    };
  }

  // ── Secuencia de calls SmartOLT ────────────────────────────────────────────

  private async runSequence(
    onu: UnconfiguredOnu,
    oltCfg: SmartOltOltConfig | null,
    vlan: number,
    wifi: WifiPlanView,
    speed: { download: string; upload: string } | null,
    contract: FiberContractSnapshot,
  ): Promise<ProvisionStepResult[]> {
    const steps: ProvisionStepResult[] = [];

    // authorize — la ÚNICA falla que aborta: sin ONU autorizada no hay nada que continuar.
    await this.gateway.authorizeOnu({
      sn: onu.sn,
      oltId: onu.oltId,
      ponType: onu.ponType,
      board: onu.board,
      port: onu.port,
      onuTypeName: onu.onuTypeName,
      vlan,
      name: this.onuLabel(contract),
      downloadSpeedProfileName: speed?.download ?? null,
      uploadSpeedProfileName: speed?.upload ?? null,
    });
    // Fix H1: sin speed profiles derivables el authorize sale SIN profile —
    // mejor que uno errado, pero tiene que quedar VISIBLE para el ajuste manual.
    steps.push(
      speed
        ? { step: 'authorize', status: 'ok' }
        : {
            step: 'authorize',
            status: 'ok',
            detail: `sin speed profiles (plan "${contract.plan}" no derivable) — ajustar a mano en SmartOLT`,
          },
    );

    // mgmt ip — solo si el catálogo conoce la VLAN de management del OLT.
    let mgmt: ProvisionStepResult;
    if (oltCfg?.mgmtVlan != null) {
      const mgmtVlan = oltCfg.mgmtVlan;
      mgmt = await this.bestEffort('mgmt_ip', () => this.gateway.setMgmtIp(onu.sn, mgmtVlan));
    } else {
      mgmt = { step: 'mgmt_ip', status: 'skipped', detail: 'sin mgmt VLAN en el catálogo del OLT' };
    }
    steps.push(mgmt);

    // Fix H2 — dependencia DURA de SmartOLT: tr069 exige la MGMT IP previa (y los
    // wifi exigen tr069, más abajo). Sin mgmt ok, esos calls fallan SIEMPRE:
    // saltarlos evita quemar rate limit y deja el motivo auditado en cada paso.
    if (mgmt.status !== 'ok') {
      const detail =
        oltCfg?.mgmtVlan != null
          ? 'requiere MGMT IP (el paso mgmt_ip no completó)'
          : 'requiere MGMT IP (mgmtVlan no configurada para esta OLT)';
      for (const step of ['tr069', 'remote_wan', 'wifi_24', 'wifi_5'] as const) {
        steps.push({ step, status: 'skipped', detail });
      }
      return steps;
    }

    const tr069 = await this.bestEffort('tr069', () =>
      this.gateway.enableTr069(onu.sn, this.tr069Profile),
    );
    steps.push(tr069);
    steps.push(await this.bestEffort('remote_wan', () => this.gateway.allowRemoteWanAccess(onu.sn)));

    // Fix H2 — los wifi dependen del TR-069: sin él se saltan con el motivo.
    if (tr069.status !== 'ok') {
      const detail = 'requiere TR-069 (el paso tr069 no completó)';
      steps.push({ step: 'wifi_24', status: 'skipped', detail });
      steps.push({ step: 'wifi_5', status: 'skipped', detail });
      return steps;
    }

    steps.push(
      await this.bestEffort('wifi_24', () =>
        this.gateway.setWifi(onu.sn, { port: 'wifi_0/1', ssid: wifi.ssid24, password: wifi.password }),
      ),
    );
    // Gotcha 5GHz: falla con "Invalid parameters" hasta que SmartOLT registre
    // wifi_0/5 para los tipos Huawei de IPNEXT — tolerada por diseño.
    steps.push(
      await this.bestEffort('wifi_5', () =>
        this.gateway.setWifi(onu.sn, { port: 'wifi_0/5', ssid: wifi.ssid5, password: wifi.password }),
      ),
    );

    return steps;
  }

  /** Ejecuta un paso post-authorize: falla → 'failed' con detalle, JAMÁS throw. */
  private async bestEffort(
    step: ProvisionStepName,
    fn: () => Promise<void>,
  ): Promise<ProvisionStepResult> {
    try {
      await fn();
      return { step, status: 'ok' };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(`[fiber-provision] paso ${step} falló (best-effort):`, detail);
      return { step, status: 'failed', detail };
    }
  }

  /** Etiqueta visible en SmartOLT: cliente + número de contrato GR. */
  private onuLabel(contract: FiberContractSnapshot): string {
    return contract.grContratoId
      ? `${contract.clientName} [${contract.grContratoId}]`
      : contract.clientName;
  }

  // ── PPPoE (K1) ───────────────────────────────────────────────────────────────

  private async ensurePppoe(contract: FiberContractSnapshot): Promise<FiberPppoeSummary> {
    try {
      const profile = (await this.ingestConfigRepo.get()).pppoeProfile;
      if (!profile || !contract.grContratoId) {
        // Sin grupo RADIUS configurado (o contrato sin número GR) no se puede
        // pre-provisionar — pero un PPPoE enabled existente SÍ se reporta.
        const rows = await this.pppoeRepo.findByContract(contract.id);
        const enabled = rows.find(p => p.status === 'enabled');
        if (enabled) return { status: 'existing', username: enabled.username };
        return { status: 'skipped' };
      }
      const outcome = await this.pregenPppoe.execute({
        contractId: contract.id,
        grContratoId: contract.grContratoId,
        grClienteId: contract.grClienteId,
        clientName: contract.clientName,
        profile,
      });
      // Fix H3: mapeo SIN aplanar — created conserva la clave (recién generada,
      // legítima) y stale conserva el reason (la advertencia correcta del K1).
      switch (outcome.status) {
        case 'created':
          return { status: 'created', username: outcome.username, password: outcome.password };
        case 'existing':
          return { status: 'existing', username: outcome.username };
        case 'stale':
          return { status: 'stale', username: outcome.username, reason: outcome.reason };
        default:
          return { status: 'failed' };
      }
    } catch (err) {
      // PregenInstallPppoe no lanza por contrato — esto cubre fallas del repo/config.
      // eslint-disable-next-line no-console
      console.warn('[fiber-provision] pre-provisión PPPoE falló (best-effort):', err);
      return { status: 'failed' };
    }
  }

  // ── dryRun: plan sin calls ───────────────────────────────────────────────────

  private async buildPlan(
    input: ProvisionFiberOnuInput,
    contract: FiberContractSnapshot,
    wifi: WifiPlanView,
    speed: { download: string; upload: string } | null,
  ): Promise<ProvisionFiberOnuPlan> {
    const vlan = input.vlan ?? null;
    const vlanView = vlan ?? '<default del catálogo del OLT — se resuelve al ejecutar>';

    // Preview PPPoE: solo LECTURA del espejo + generación determinística (sin writes).
    const rows = await this.pppoeRepo.findByContract(contract.id);
    const enabled = rows.find(p => p.status === 'enabled');
    const pending = rows.find(p => p.status === 'pending');
    const pppoe: ProvisionFiberOnuPlan['pppoe'] = enabled
      ? { action: 'reuse-existing', username: enabled.username }
      : pending
        ? { action: 'review-stale', username: pending.username }
        : {
            action: 'generate',
            username: generatePppoeCredentials(contract.clientName, contract.grContratoId ?? '')
              .username,
          };

    const plan: PlannedCall[] = [
      {
        call: 'GET onu/unconfigured_onus',
        params: { resolver: `board/port/pon_type/onu_type de ${input.onuSn}` },
      },
      {
        call: 'POST onu/authorize_onu',
        params: {
          sn: input.onuSn,
          vlan: vlanView,
          name: this.onuLabel(contract),
          download_speed_profile_name: speed?.download ?? null,
          upload_speed_profile_name: speed?.upload ?? null,
        },
      },
      {
        call: 'POST onu/set_onu_mgmt_ip_static_ip/<sn>',
        params: { vlan: '<mgmtVlan del catálogo del OLT — se SALTA si es null>' },
      },
      { call: 'POST onu/enable_tr069/<sn>', params: { tr069_profile: this.tr069Profile } },
      { call: 'POST onu/enable_allow_remote_access_to_wan_ip/<sn>', params: {} },
      {
        call: 'POST onu/set_wifi_port_lan/<sn> (2.4GHz)',
        params: { wifi_port: 'wifi_0/1', ssid: wifi.ssid24, password: wifi.password },
      },
      {
        call: 'POST onu/set_wifi_port_lan/<sn> (5GHz)',
        params: {
          wifi_port: 'wifi_0/5',
          ssid: wifi.ssid5,
          password: wifi.password,
          nota: 'best-effort: SmartOLT no tiene wifi_0/5 para los tipos Huawei de IPNEXT — puede fallar y se tolera',
        },
      },
    ];

    return {
      dryRun: true,
      contractId: contract.id,
      onuSn: input.onuSn,
      vlan,
      wifi,
      pppoe,
      plan,
    };
  }

  // ── Auditoría en la tarea ────────────────────────────────────────────────────

  private async appendToInstallTask(
    contractId: string,
    block: {
      sn: string;
      oltLabel: string;
      vlan: number;
      wifi: WifiPlanView;
      pppoe: FiberPppoeSummary;
      steps: ProvisionStepResult[];
      origin?: 'manual' | 'watcher';
    },
    auditTaskId?: string,
  ): Promise<boolean> {
    try {
      // M4 — el watcher audita en la tarea MATCHEADA; el wizard en la última del contrato.
      const task = auditTaskId != null
        ? await this.taskWriter.findById(auditTaskId)
        : await this.taskWriter.findLatestByContract(contractId);
      if (!task) return false;
      const rendered = renderOnuProvisioningBlock(block);
      const description = task.description ? `${task.description}\n\n${rendered}` : rendered;
      await this.taskWriter.updateDescription(task.id, description);
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[fiber-provision] no se pudo appendear el bloque a la tarea (best-effort):', err);
      return false;
    }
  }
}
