import type { OltProvisioningGateway } from '@domain/ports/OltProvisioningGateway';
import { normalizeOnuSerial } from '@domain/services/normalizeOnuSerial';

export interface EnableOnuTr069Input {
  vlan: number;
  /** Default 'SmartOLT'. 'Wispcontrol' también es válido — existe en 429 ONUs del parque (proposal.md). */
  tr069Profile?: string;
}

const DEFAULT_TR069_PROFILE = 'SmartOLT';

/**
 * wifi-self-service (F0) — `POST /api/wifi/onu/:serial/enable-tr069` (admin,
 * `wifi.manage`). Cadena verificada EN VIVO por el proposal (§Evidencia):
 * `set_onu_mgmt_ip_static_ip` (requiere la VLAN de mgmt del OLT — MERCEDES1=11,
 * ESTUDIANTES=12, SIN default: el operador la elige) -> `enable_tr069`. El
 * ORDEN importa (mgmt PRIMERO) — reusa `OltProvisioningGateway.setMgmtIp` /
 * `.enableTr069`, YA implementados por `smartolt-provision` (K2); F0 no
 * duplica esa lógica, solo la encadena para el flujo de WiFi self-service.
 *
 * La app JAMÁS dispara esta cadena — solo Prominense staff (proposal regla 1).
 */
export class EnableOnuTr069 {
  constructor(private readonly provisioning: Pick<OltProvisioningGateway, 'setMgmtIp' | 'enableTr069'>) {}

  async execute(serialRaw: string, input: EnableOnuTr069Input): Promise<void> {
    const sn = normalizeOnuSerial(serialRaw);
    await this.provisioning.setMgmtIp(sn, input.vlan);
    await this.provisioning.enableTr069(sn, input.tr069Profile ?? DEFAULT_TR069_PROFILE);
  }
}
