import type {
  OnuWifiCredential,
  OnuWifiCredentialRepository,
  UpsertOnuWifiCredentialInput,
} from '@domain/ports/OnuWifiCredentialRepository';

/**
 * wifi-password-snapshot — fake in-memory del snapshot de password WiFi.
 * Upsert por (sn, port), como el unique compuesto de la tabla real
 * (`OnuWifiCredential_sn_port_key`) — la clave del Map DEBE incluir AMBOS
 * campos: escribir la banda 2.4 no puede pisar la de 5 de la MISMA sn.
 */
export class InMemoryOnuWifiCredentialRepository implements OnuWifiCredentialRepository {
  private readonly rows = new Map<string, OnuWifiCredential>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private key(sn: string, port: string): string {
    return `${sn}::${port}`;
  }

  async findManyBySn(sn: string): Promise<OnuWifiCredential[]> {
    return [...this.rows.values()].filter((r) => r.sn === sn).map((r) => ({ ...r }));
  }

  async upsert(input: UpsertOnuWifiCredentialInput): Promise<void> {
    this.rows.set(this.key(input.sn, input.port), {
      sn: input.sn,
      port: input.port,
      ssid: input.ssid,
      password: input.password,
      updatedBy: input.updatedBy,
      updatedAt: new Date(this.now()).toISOString(),
    });
  }

  /** Test seam: todas las filas persistidas. */
  all(): OnuWifiCredential[] {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
}
