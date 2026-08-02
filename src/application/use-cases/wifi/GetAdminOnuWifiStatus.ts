import type { WifiManagementPort } from '@domain/ports/WifiManagementPort';
import type { OnuWifiCredentialRepository } from '@domain/ports/OnuWifiCredentialRepository';
import { normalizeOnuSerial } from '@domain/services/normalizeOnuSerial';
import { AdminOnuWifiStatusDto, toAdminWifiDeviceDto } from '@application/dto/wifi.dto';

/**
 * wifi-self-service (F0) — `GET /api/wifi/onu/:serial` (admin, `wifi.read`).
 * Va por SERIAL, no por contrato — staff opera ONUs aunque no estén asociadas
 * todavía a un contrato (proposal: "estas rutas van por serial"). Staff SÍ ve
 * ip/mac de los hosts (a diferencia del portal). `getOnuWifiStatus`/
 * `getRouterHosts` propagan `OltProvisioningError` tal cual — el errorHandler
 * global lo mapea a 503/502/422 (SMARTOLT_*), nada se traga acá.
 *
 * wifi-password-snapshot — `password` por banda sale del snapshot propio
 * (`OnuWifiCredentialRepository.findManyBySn`), NUNCA de SmartOLT.
 */
export class GetAdminOnuWifiStatus {
  constructor(
    private readonly wifi: Pick<WifiManagementPort, 'getOnuWifiStatus' | 'getRouterHosts'>,
    private readonly credentials: Pick<OnuWifiCredentialRepository, 'findManyBySn'>,
  ) {}

  async execute(serialRaw: string): Promise<AdminOnuWifiStatusDto> {
    const sn = normalizeOnuSerial(serialRaw);
    const status = await this.wifi.getOnuWifiStatus(sn);
    const hosts = await this.wifi.getRouterHosts(sn);
    const saved = await this.credentials.findManyBySn(sn);
    const passwordByPort = new Map(saved.map((c) => [c.port, c.password]));

    return {
      sn,
      found: status.found,
      onuType: status.onuType,
      online: status.online,
      tr069Enabled: status.tr069Enabled,
      bands: status.bands.map((b) => ({ ...b, password: passwordByPort.get(b.port) ?? null })),
      hosts: hosts.map(toAdminWifiDeviceDto),
    };
  }
}
