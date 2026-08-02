import type { WifiManagementPort } from '@domain/ports/WifiManagementPort';
import { normalizeOnuSerial } from '@domain/services/normalizeOnuSerial';
import { AdminOnuWifiStatusDto, toAdminWifiDeviceDto } from '@application/dto/wifi.dto';

/**
 * wifi-self-service (F0) — `GET /api/wifi/onu/:serial` (admin, `wifi.read`).
 * Va por SERIAL, no por contrato — staff opera ONUs aunque no estén asociadas
 * todavía a un contrato (proposal: "estas rutas van por serial"). Staff SÍ ve
 * ip/mac de los hosts (a diferencia del portal). `getOnuWifiStatus`/
 * `getRouterHosts` propagan `OltProvisioningError` tal cual — el errorHandler
 * global lo mapea a 503/502/422 (SMARTOLT_*), nada se traga acá.
 */
export class GetAdminOnuWifiStatus {
  constructor(private readonly wifi: Pick<WifiManagementPort, 'getOnuWifiStatus' | 'getRouterHosts'>) {}

  async execute(serialRaw: string): Promise<AdminOnuWifiStatusDto> {
    const sn = normalizeOnuSerial(serialRaw);
    const status = await this.wifi.getOnuWifiStatus(sn);
    const hosts = await this.wifi.getRouterHosts(sn);

    return {
      sn,
      found: status.found,
      onuType: status.onuType,
      online: status.online,
      tr069Enabled: status.tr069Enabled,
      bands: status.bands,
      hosts: hosts.map(toAdminWifiDeviceDto),
    };
  }
}
