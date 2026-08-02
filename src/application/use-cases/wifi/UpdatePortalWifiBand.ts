import type { ResolveWifiEligibility } from './ResolveWifiEligibility';
import type { WifiManagementPort } from '@domain/ports/WifiManagementPort';
import type { OnuWifiCredentialRepository } from '@domain/ports/OnuWifiCredentialRepository';
import { validateWifiSsid, validateWifiPassword } from '@domain/services/validateWifiCredentials';
import { WifiNotEligibleError } from '@domain/errors/wifi';

export interface UpdatePortalWifiBandInput {
  band: '2.4' | '5';
  ssid: string;
  password: string;
}

/**
 * wifi-self-service (F0) — `PUT /api/portal/wifi/:contractId`.
 *
 * REGLA DURA (proposal.md regla 2, "el server las re-verifica en cada
 * escritura"): esta escritura corre `ResolveWifiEligibility` COMPLETO de
 * nuevo — NUNCA confía en un estado leído en un GET anterior. Si la ONU dejó
 * de ser elegible entre el GET y el PUT (perdió TR-069, se desconectó del
 * inventario, etc.) la escritura se RECHAZA con `WifiNotEligibleError`, jamás
 * aplica un cambio a ciegas.
 *
 * `setWifiBand` SIEMPRE fuerza WPA2 (a nivel adapter — ver
 * `SmartOltHttpGateway.postSetWifiPort`) — la app nunca puede pedir Open-system.
 *
 * wifi-password-snapshot — tras un `setWifiBand` EXITOSO, upsert del snapshot
 * (`updatedBy: 'portal'`). Si el upsert falla, NO tumba el PUT — el equipo YA
 * cambió, un 500 acá mentiría ("no se aplicó") sobre un cambio que sí se
 * aplicó. Se loguea best-effort y se sigue (mismo criterio que el resto de
 * los `console.warn(...best-effort...)` del repo, ver p.ej. `AddContractService`).
 */
export class UpdatePortalWifiBand {
  constructor(
    private readonly resolveEligibility: ResolveWifiEligibility,
    private readonly wifi: Pick<WifiManagementPort, 'setWifiBand'>,
    private readonly credentials: Pick<OnuWifiCredentialRepository, 'upsert'>,
  ) {}

  async execute(clientId: string, contractId: string, input: UpdatePortalWifiBandInput): Promise<void> {
    validateWifiSsid(input.ssid);
    validateWifiPassword(input.password);

    // Anti-IDOR + las 3 condiciones de elegibilidad, re-corridas ENTERAS.
    const result = await this.resolveEligibility.execute(clientId, contractId);
    if (!result.eligible) {
      throw new WifiNotEligibleError(result.reason);
    }

    const target = result.bands.find((b) => b.band === input.band);
    if (!target) {
      // La ONU es elegible pero no tiene ESA banda puntual (p.ej. pidió 5GHz
      // en una ONU solo-2.4) — mismo reason que "sin puertos" para esa banda.
      throw new WifiNotEligibleError('no_wifi_ports');
    }

    await this.wifi.setWifiBand(result.sn, { port: target.port, ssid: input.ssid, password: input.password });

    try {
      await this.credentials.upsert({
        sn: result.sn,
        port: target.port,
        ssid: input.ssid,
        password: input.password,
        updatedBy: 'portal',
      });
    } catch (err) {
      console.warn('[UpdatePortalWifiBand] snapshot de password falló (best-effort — el equipo ya cambió):', err);
    }
  }
}
