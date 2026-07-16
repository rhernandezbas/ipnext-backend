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
  FiberVlanRequiredError,
  UnconfiguredOnuNotFoundError,
} from '@domain/errors/smartolt';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import { PregenInstallPppoe } from './PregenInstallPppoe';

/** Profile TR-069 default de la instancia IPNEXT (verificado en la skill smartolt). */
const DEFAULT_TR069_PROFILE = 'SmartOLT';

/** Header del bloque de auditoría en la descripción de la tarea (espejo del K1). */
const BLOCK_HEADER = '── Aprovisionamiento ONU ──';

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
  updateDescription(taskId: string, description: string): Promise<void>;
}

export interface ProvisionFiberOnuInput {
  contractId: string;
  onuSn: string;
  /** VLAN de servicio explícita — gana sobre el default del catálogo. */
  vlan?: number;
  /** true → NO llama al gateway: devuelve el PLAN de calls para aprobación. */
  dryRun?: boolean;
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
 *  - created/existing/stale → mapeo directo del outcome de PregenInstallPppoe.
 *  - failed  → la pre-provisión explotó (orchestrator caído, etc.) — no aborta la ONU.
 *  - skipped → sin `pppoeProfile` configurado o contrato sin número GR: no se puede
 *              pre-provisionar; si el contrato ya tenía un PPPoE enabled se reporta existing.
 */
export type FiberPppoeSummary =
  | { status: 'created' | 'existing' | 'stale'; username: string }
  | { status: 'failed' | 'skipped' };

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
 * instalación (mismo espíritu que renderPppoeCredentialsBlock del K1): el
 * instalador ve sn, OLT/VLAN, credenciales WiFi y el estado por paso.
 */
export function renderOnuProvisioningBlock(params: {
  sn: string;
  oltLabel: string;
  vlan: number;
  wifi: WifiPlanView;
  steps: ProvisionStepResult[];
}): string {
  const pasos = params.steps
    .map(s => `${s.step} ${STEP_SYMBOLS[s.status]}${s.detail ? ` (${s.detail})` : ''}`)
    .join(' · ');
  return (
    `${BLOCK_HEADER}\n` +
    `SN: ${params.sn}\n` +
    `OLT: ${params.oltLabel} · VLAN ${params.vlan}\n` +
    `WiFi 2.4: ${params.wifi.ssid24}\n` +
    `WiFi 5: ${params.wifi.ssid5}\n` +
    `Clave WiFi: ${params.wifi.password}\n` +
    `Pasos: ${pasos}`
  );
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
 *  6. Secuencia SmartOLT: authorize → mgmt ip (si mgmtVlan del catálogo; si no,
 *     skipped) → tr069 → remote wan → wifi 2.4 → wifi 5.
 *     - authorize falla → ABORTA (nada quedó aprovisionado; el error tipado llega a la ruta).
 *     - pasos POSTERIORES fallan → best-effort: se registra 'failed' y se sigue
 *       (la ONU ya está autorizada; abortar dejaría peor estado que continuar).
 *       Gotcha 5GHz: wifi_0/5 no existe para los tipos Huawei de IPNEXT en SmartOLT
 *       → falla con "Invalid parameters" SIEMPRE, tolerada por diseño.
 *  7. Auditoría: appendea el bloque "── Aprovisionamiento ONU ──" a la descripción
 *     de la última tarea del contrato (best-effort — sin tarea no es error).
 *
 * dryRun=true → CERO llamadas al gateway y CERO side-effects (ni PPPoE ni tarea):
 * devuelve el PLAN de calls que haría, para que el usuario lo apruebe. Nota: sin
 * el gateway no se conoce el OLT de la ONU, así que la VLAN default y el board/port
 * quedan "a resolver al ejecutar" cuando el input no trae vlan.
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

    // Derivaciones puras: SSIDs, clave WiFi, speed profiles.
    const ssids = deriveWifiSsids(contract.clientName);
    const password = deriveWifiPassword(contract.grContratoId, this.rng);
    const wifi: WifiPlanView = { ...ssids, password };
    const speed = deriveSpeedProfileNames(contract.plan);

    if (input.dryRun) return this.buildPlan(input, contract, wifi, speed);

    // 3. La ONU tiene que estar detectada y sin configurar.
    const onus = await this.gateway.listUnconfiguredOnus();
    const onu = onus.find(o => o.sn === input.onuSn);
    if (!onu) throw new UnconfiguredOnuNotFoundError(input.onuSn);

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
      steps,
    });

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
    steps.push({ step: 'authorize', status: 'ok' });

    // mgmt ip — solo si el catálogo conoce la VLAN de management del OLT.
    if (oltCfg?.mgmtVlan != null) {
      const mgmtVlan = oltCfg.mgmtVlan;
      steps.push(await this.bestEffort('mgmt_ip', () => this.gateway.setMgmtIp(onu.sn, mgmtVlan)));
    } else {
      steps.push({ step: 'mgmt_ip', status: 'skipped', detail: 'sin mgmt VLAN en el catálogo del OLT' });
    }

    steps.push(await this.bestEffort('tr069', () => this.gateway.enableTr069(onu.sn, this.tr069Profile)));
    steps.push(await this.bestEffort('remote_wan', () => this.gateway.allowRemoteWanAccess(onu.sn)));
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
      if (outcome.status === 'failed') return { status: 'failed' };
      return { status: outcome.status, username: outcome.username };
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
    block: { sn: string; oltLabel: string; vlan: number; wifi: WifiPlanView; steps: ProvisionStepResult[] },
  ): Promise<boolean> {
    try {
      const task = await this.taskWriter.findLatestByContract(contractId);
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
