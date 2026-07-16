import {
  OltProvisioningGateway,
  UnconfiguredOnu,
  AuthorizeOnuInput,
  SetWifiInput,
} from '@domain/ports/OltProvisioningGateway';
import { OltProvisioningError } from '@domain/errors/smartolt';

/** Una llamada registrada por el fake — los tests asserten sobre esto. */
export type RecordedGatewayCall =
  | { method: 'listUnconfiguredOnus' }
  | { method: 'authorizeOnu'; input: AuthorizeOnuInput }
  | { method: 'setMgmtIp'; sn: string; vlan: number }
  | { method: 'enableTr069'; sn: string; profile: string }
  | { method: 'allowRemoteWanAccess'; sn: string }
  | { method: 'setWifi'; sn: string; input: SetWifiInput };

type WriteMethod = 'authorizeOnu' | 'setMgmtIp' | 'enableTr069' | 'allowRemoteWanAccess';

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
export class InMemoryOltProvisioningGateway implements OltProvisioningGateway {
  readonly calls: RecordedGatewayCall[] = [];
  unconfigured: UnconfiguredOnu[] = [];
  failWifiPorts: Array<SetWifiInput['port']> = [];
  failMethods: WriteMethod[] = [];
  unreachable = false;
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
}
