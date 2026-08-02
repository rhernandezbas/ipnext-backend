import type { WifiManagementPort } from '@domain/ports/WifiManagementPort';
import type { OnuWifiCredentialRepository } from '@domain/ports/OnuWifiCredentialRepository';
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
 *
 * wifi-password-snapshot — tras un `setWifiBand` EXITOSO, upsert del
 * snapshot con `updatedBy: 'staff:<rbacUserId>'` (a diferencia del portal,
 * que graba `'portal'` — así se audita QUIÉN escribió último). `staffUserId`
 * lo resuelve la ruta de `req.user.id` (sesión ya autenticada por
 * `wifi.manage`), nunca del body. Mismo criterio best-effort que el portal:
 * si el upsert falla, NO tumba el PUT — el equipo ya cambió.
 */
export class SetAdminWifiBand {
  constructor(
    private readonly wifi: Pick<WifiManagementPort, 'setWifiBand'>,
    private readonly credentials: Pick<OnuWifiCredentialRepository, 'upsert'>,
  ) {}

  async execute(serialRaw: string, input: SetAdminWifiBandInput, staffUserId: string): Promise<void> {
    validateWifiPort(input.port);
    validateWifiSsid(input.ssid);
    validateWifiPassword(input.password);

    const sn = normalizeOnuSerial(serialRaw);
    await this.wifi.setWifiBand(sn, { port: input.port, ssid: input.ssid, password: input.password });

    try {
      await this.credentials.upsert({
        sn,
        port: input.port,
        ssid: input.ssid,
        password: input.password,
        updatedBy: `staff:${staffUserId}`,
      });
    } catch (err) {
      console.warn('[SetAdminWifiBand] snapshot de password falló (best-effort — el equipo ya cambió):', err);
    }
  }
}
