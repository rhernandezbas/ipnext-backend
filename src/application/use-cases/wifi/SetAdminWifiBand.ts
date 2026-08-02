import type { WifiManagementPort } from '@domain/ports/WifiManagementPort';
import { normalizeOnuSerial } from '@domain/services/normalizeOnuSerial';
import { validateWifiSsid, validateWifiPassword, validateWifiPort } from '@domain/services/validateWifiCredentials';

export interface SetAdminWifiBandInput {
  port: string;
  ssid: string;
  password: string;
}

/**
 * wifi-self-service (F0) — `PUT /api/wifi/onu/:serial/band` (admin,
 * `wifi.manage`). A diferencia del PUT del portal, acepta CUALQUIER puerto
 * explícito (`wifi_0/1`..`wifi_0/8`) — el staff no está limitado al puerto
 * "principal" de una banda. Mismas reglas de forma (ssid/password, SIEMPRE
 * WPA2 vía el adapter) — nunca se abre la puerta a un password débil ni a
 * Open-system desde acá tampoco.
 */
export class SetAdminWifiBand {
  constructor(private readonly wifi: Pick<WifiManagementPort, 'setWifiBand'>) {}

  async execute(serialRaw: string, input: SetAdminWifiBandInput): Promise<void> {
    validateWifiPort(input.port);
    validateWifiSsid(input.ssid);
    validateWifiPassword(input.password);

    const sn = normalizeOnuSerial(serialRaw);
    await this.wifi.setWifiBand(sn, { port: input.port, ssid: input.ssid, password: input.password });
  }
}
