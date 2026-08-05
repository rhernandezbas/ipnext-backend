import {
  OltProvisioningGateway,
  UnconfiguredOnu,
  AuthorizeOnuInput,
  SetWifiInput,
} from '@domain/ports/OltProvisioningGateway';
import {
  WifiManagementPort,
  OnuWifiStatus,
  SetWifiBandInput,
  RouterHost,
  OnlineWifiMac,
} from '@domain/ports/WifiManagementPort';
import { OltProvisioningError } from '@domain/errors/smartolt';
import { mapWifiPortsToBands, mapWifiPortsToGuest, RawWifiPort } from '@domain/services/mapWifiPortsToBands';

/** Una llamada registrada por el fake — los tests asserten sobre esto. */
export type RecordedGatewayCall =
  | { method: 'listUnconfiguredOnus' }
  | { method: 'authorizeOnu'; input: AuthorizeOnuInput }
  | { method: 'setMgmtIp'; sn: string; vlan: number }
  | { method: 'enableTr069'; sn: string; profile: string }
  | { method: 'allowRemoteWanAccess'; sn: string }
  | { method: 'setWifi'; sn: string; input: SetWifiInput }
  | { method: 'reboot'; sn: string }
  // EPIC v3 (wifi de visitas) — escrituras del lado WifiManagementPort.
  | { method: 'setWifiBand'; sn: string; input: SetWifiBandInput }
  | { method: 'shutdownWifiPort'; sn: string; port: string }
  // wifi-guest-pending — lectura VIVA registrada A PROPÓSITO (única read en
  // `calls`): los tests asserten CUÁNTAS verificaciones dispara la evaluación
  // lazy (presupuesto del rate limit 1000/h de SmartOLT).
  | { method: 'getOnlineWifiMacs'; sn: string };

type WriteMethod = 'authorizeOnu' | 'setMgmtIp' | 'enableTr069' | 'allowRemoteWanAccess' | 'reboot' | 'shutdownWifiPort';

/**
 * EPIC v3 (wifi de visitas) — estado de UNA ONU del lado WifiManagementPort.
 * `ports` es el template crudo (mismo shape que consume el adapter real);
 * bands/guest se derivan con las MISMAS funciones de dominio que
 * `SmartOltHttpGateway.toOnuWifiStatus` — el fake nunca reimplementa la regla.
 */
export interface InMemoryWifiOnuState {
  onuType?: string | null;
  online?: boolean;
  tr069Enabled?: boolean;
  ports: RawWifiPort[];
}

/**
 * smartolt-provision (K2) — fake COMPLETO del gateway SmartOLT para tests
 * (JAMÁS se toca la API viva). Registra cada llamada en `calls` y permite
 * simular fallas por método/puerto WiFi:
 *  - `failWifiPorts`: puertos WiFi que rechazan (el gotcha 5GHz real:
 *    'wifi_0/5' → "Invalid parameters" para los tipos Huawei de IPNEXT).
 *  - `failMethods`: métodos de escritura que rechazan.
 *  - `unreachable`: TODA llamada falla con reason 'unreachable'.
 *
 * Fix H2 — el fake MODELA la dependencia dura de SmartOLT (skill smartolt-ipnext):
 * tr069 EXIGE mgmt IP previa en esa ONU, y wifi EXIGE tr069 previo. Un caller
 * que viole el orden falla acá igual que fallaría en la instancia real — un
 * "tr069 falló pero el wifi salió ok" es IMPOSIBLE por construcción.
 */
export class InMemoryOltProvisioningGateway implements OltProvisioningGateway, WifiManagementPort {
  readonly calls: RecordedGatewayCall[] = [];
  unconfigured: UnconfiguredOnu[] = [];
  failWifiPorts: string[] = [];
  failMethods: WriteMethod[] = [];
  unreachable = false;
  /** EPIC v3 — estado WiFi por sn (lado WifiManagementPort). Sin entrada = found:false. */
  readonly wifiOnus = new Map<string, InMemoryWifiOnuState>();
  /** EPIC v3 — hosts del router por sn (getRouterHosts). */
  readonly routerHostsBySn = new Map<string, RouterHost[]>();
  /** wifi-guest-pending — MACs online por sn (lectura VIVA del ONT, getOnlineWifiMacs). */
  readonly onlineWifiMacsBySn = new Map<string, OnlineWifiMac[]>();
  /**
   * wifi-guest-pending — SOLO la verificación viva falla (SmartOLT caído a
   * mitad del flujo), sin tumbar `getOnuWifiStatus` (que en prod sobrevive por
   * su cache 60s): modela "elegibilidad resuelta, verificación degradada".
   */
  failOnlineWifiMacs = false;
  /** ONUs con mgmt IP ya seteada (prerrequisito de tr069). */
  private readonly mgmtDone = new Set<string>();
  /** ONUs con TR-069 habilitado (prerrequisito de wifi). */
  private readonly tr069Done = new Set<string>();

  private guardUnreachable(): void {
    if (this.unreachable) {
      throw new OltProvisioningError('unreachable', 'SmartOLT unreachable (fake)');
    }
  }

  private guardMethod(method: WriteMethod): void {
    if (this.failMethods.includes(method)) {
      throw new OltProvisioningError('rejected', `SmartOLT rechazó ${method} (fake)`);
    }
  }

  /** Métodos de escritura invocados, en orden — para assertar la SECUENCIA. */
  writeSequence(): string[] {
    return this.calls
      .filter(c => c.method !== 'listUnconfiguredOnus')
      .map(c => (c.method === 'setWifi' ? `setWifi:${c.input.port}` : c.method));
  }

  async listUnconfiguredOnus(): Promise<UnconfiguredOnu[]> {
    this.guardUnreachable();
    this.calls.push({ method: 'listUnconfiguredOnus' });
    return this.unconfigured.map(o => ({ ...o }));
  }

  async authorizeOnu(input: AuthorizeOnuInput): Promise<void> {
    this.guardUnreachable();
    this.guardMethod('authorizeOnu');
    this.calls.push({ method: 'authorizeOnu', input: { ...input } });
  }

  async setMgmtIp(sn: string, vlan: number): Promise<void> {
    this.guardUnreachable();
    this.guardMethod('setMgmtIp');
    this.calls.push({ method: 'setMgmtIp', sn, vlan });
    this.mgmtDone.add(sn);
  }

  async enableTr069(sn: string, profile: string): Promise<void> {
    this.guardUnreachable();
    this.guardMethod('enableTr069');
    if (!this.mgmtDone.has(sn)) {
      // Réplica de la dependencia real: SmartOLT exige la MGMT IP antes del TR-069.
      throw new OltProvisioningError(
        'rejected',
        `TR-069 requiere MGMT IP previa en ${sn} (dependencia SmartOLT modelada por el fake)`,
      );
    }
    this.calls.push({ method: 'enableTr069', sn, profile });
    this.tr069Done.add(sn);
  }

  async allowRemoteWanAccess(sn: string): Promise<void> {
    this.guardUnreachable();
    this.guardMethod('allowRemoteWanAccess');
    this.calls.push({ method: 'allowRemoteWanAccess', sn });
  }

  async setWifi(sn: string, input: SetWifiInput): Promise<void> {
    this.guardUnreachable();
    if (!this.tr069Done.has(sn)) {
      // Réplica de la dependencia real: sin TR-069 habilitado el wifi NO se configura.
      throw new OltProvisioningError(
        'rejected',
        `WiFi requiere TR-069 previo en ${sn} (dependencia SmartOLT modelada por el fake)`,
      );
    }
    if (this.failWifiPorts.includes(input.port)) {
      // Réplica del gotcha real: SmartOLT sin wifi_0/5 para los tipos Huawei de IPNEXT.
      throw new OltProvisioningError('rejected', 'Invalid parameters');
    }
    this.calls.push({ method: 'setWifi', sn, input: { ...input } });
  }

  /** portal-equipment-reboot — sin dependencias previas modeladas (a diferencia de tr069/wifi, el reboot va por OMCI). */
  async reboot(sn: string): Promise<void> {
    this.guardUnreachable();
    this.guardMethod('reboot');
    this.calls.push({ method: 'reboot', sn });
  }

  // ── WifiManagementPort (EPIC v3 — wifi de visitas) ─────────────────────────
  // El estado vive en `wifiOnus` como puertos CRUDOS; bands/guest se derivan
  // con las mismas funciones de dominio que el adapter real — un test que
  // escribe por `setWifiBand`/`shutdownWifiPort` ve el cambio reflejado en el
  // próximo `getOnuWifiStatus`, igual que en prod tras la invalidación de cache.

  async getOnuWifiStatus(sn: string): Promise<OnuWifiStatus> {
    this.guardUnreachable();
    const onu = this.wifiOnus.get(sn);
    if (!onu) {
      return { found: false, onuType: null, online: false, tr069Enabled: false, bands: [], guest: mapWifiPortsToGuest([]) };
    }
    return {
      found: true,
      onuType: onu.onuType ?? null,
      online: onu.online ?? true,
      tr069Enabled: onu.tr069Enabled ?? true,
      bands: mapWifiPortsToBands(onu.ports),
      guest: mapWifiPortsToGuest(onu.ports),
    };
  }

  async setWifiBand(sn: string, input: SetWifiBandInput): Promise<void> {
    this.guardUnreachable();
    if (this.failWifiPorts.includes(input.port)) {
      throw new OltProvisioningError('rejected', 'Invalid parameters');
    }
    this.calls.push({ method: 'setWifiBand', sn, input: { ...input } });
    const port = this.wifiOnus.get(sn)?.ports.find((p) => p.port === input.port);
    if (port) {
      port.ssid = input.ssid;
      port.enabled = true;
    }
  }

  async shutdownWifiPort(sn: string, port: string): Promise<void> {
    this.guardUnreachable();
    this.guardMethod('shutdownWifiPort');
    this.calls.push({ method: 'shutdownWifiPort', sn, port });
    const target = this.wifiOnus.get(sn)?.ports.find((p) => p.port === port);
    if (target) target.enabled = false;
  }

  async getRouterHosts(sn: string): Promise<RouterHost[]> {
    this.guardUnreachable();
    return (this.routerHostsBySn.get(sn) ?? []).map((h) => ({ ...h }));
  }

  async getOnlineWifiMacs(sn: string): Promise<OnlineWifiMac[]> {
    this.guardUnreachable();
    if (this.failOnlineWifiMacs) {
      throw new OltProvisioningError('unreachable', 'SmartOLT full_status unreachable (fake)');
    }
    this.calls.push({ method: 'getOnlineWifiMacs', sn });
    return (this.onlineWifiMacsBySn.get(sn) ?? []).map((m) => ({ ...m }));
  }
}
