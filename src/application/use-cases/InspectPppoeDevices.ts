import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
import { AirOsGateway } from '@domain/ports/AirOsGateway';
import { AirOsUnreachableError } from '@domain/errors/airos';
import { vendorFromMac } from './ouiVendor';

/**
 * Resultado de la inspección SSH de la antena del cliente.
 * Siempre retorna un objeto (best-effort): los campos `null` + `warnings` indican
 * lo que no se pudo obtener y por qué.
 */
export interface InspectPppoeDevicesResult {
  antenna: {
    /** MAC de la antena (deviceId del mca-status, o caller-id del RADIUS si SSH falló). */
    mac: string | null;
    /** Modelo de la antena (platform= del mca-status). `null` si SSH falló. */
    model: string | null;
  };
  /** Router del cliente (primera MAC de la ARP table LAN). `null` si no se encontró. */
  router: {
    mac: string;
    brand: string | null;
    /** Modelo del router leído del DHCP lease de la antena (hostname). `null` si no hay lease. */
    model: string | null;
  } | null;
  /** Mensajes informativos/advertencias para el operador (vacío si todo salió bien). */
  warnings: string[];
}

/**
 * InspectPppoeDevices — inspecciona la antena Ubiquiti airOS del contrato por SSH y retorna
 * el modelo + MAC de la antena y el MAC del router del cliente.
 *
 * Flujo:
 *   1. Busca el PPPoE `enabled` del contrato.
 *   2. IP de la antena = `pppoe.remoteAddress`.
 *   3. MAC fallback = caller-id de la sesión activa en el orchestrator.
 *   4. Si hay IP: `airos.inspect(ip)` → model, ownMac, lanMacs.
 *   5. Router = primera MAC de lanMacs (excluyendo ownMac) con brand lookup.
 *   6. Errores de red (AirOsUnreachableError) → best-effort: retorna lo que tenga + warning.
 *
 * Gated por `inventory.write` (el botón "Detectar equipos" del contrato).
 */
export class InspectPppoeDevices {
  constructor(
    private readonly pppoeRepo: PppoeServiceRepository,
    private readonly orchestrator: RadiusOrchestratorGateway,
    private readonly airos: AirOsGateway,
  ) {}

  async execute(contractId: string): Promise<InspectPppoeDevicesResult> {
    const warnings: string[] = [];

    // 1. Buscar PPPoE activo del contrato
    const pppoeList = await this.pppoeRepo.findByContract(contractId);
    const pppoe = pppoeList.find(p => p.status === 'enabled');

    if (!pppoe) {
      warnings.push('No hay PPPoE activo en el contrato');
      return { antenna: { mac: null, model: null }, router: null, warnings };
    }

    // 3. Caller-id fallback (MAC de la sesión PPPoE activa)
    let callerIdMac: string | null = null;
    try {
      const sessions = await this.orchestrator.listSessions(pppoe.username);
      if (sessions.length > 0) {
        callerIdMac = sessions[0]!.callerId;
      }
    } catch {
      // best-effort: si el orchestrator no responde, seguimos sin caller-id
    }

    // 2. Verificar que hay IP de antena
    const remoteAddress = pppoe.remoteAddress;
    if (!remoteAddress) {
      warnings.push('El PPPoE no tiene IP asignada; no se puede inspeccionar la antena');
      return {
        antenna: { mac: callerIdMac, model: null },
        router: null,
        warnings,
      };
    }

    // 4. Inspeccionar antena vía SSH
    try {
      const airosResult = await this.airos.inspect(remoteAddress);

      // Antenna: usa ownMac del SSH, fallback al caller-id
      const antennaMac = airosResult.ownMac ?? callerIdMac;

      // 5. Router: primera MAC de lanMacs excluyendo la propia antena
      const ownMacNorm = airosResult.ownMac ? airosResult.ownMac.toLowerCase() : null;
      const callerNorm = callerIdMac ? callerIdMac.toLowerCase() : null;

      const routerMac = airosResult.lanMacs.find(mac => {
        const m = mac.toLowerCase();
        if (ownMacNorm && m === ownMacNorm) return false;
        if (callerNorm && m === callerNorm) return false;
        return true;
      }) ?? null;

      let router: InspectPppoeDevicesResult['router'] = null;
      if (routerMac) {
        // Modelo del router desde el DHCP lease de la antena (cruce por MAC). Best-effort: null si no hay.
        const leases = airosResult.leases ?? {};
        const model = leases[routerMac.toLowerCase()] ?? null;
        router = { mac: routerMac, brand: vendorFromMac(routerMac), model };
      } else {
        warnings.push('No se encontró router del cliente en la antena (ARP vacío)');
      }

      return {
        antenna: { mac: antennaMac, model: airosResult.model },
        router,
        warnings,
      };
    } catch (err) {
      // Best-effort TOTAL: cualquier fallo de la inspección (SSH offline, parse roto,
      // adapter que no envuelve bien) NO debe tumbar la request. Se degrada al caller-id.
      warnings.push(
        err instanceof AirOsUnreachableError
          ? 'No se pudo entrar a la antena por SSH (offline?). Se usa solo el caller-id.'
          : 'Falló la inspección de la antena. Se usa solo el caller-id.',
      );
      return {
        antenna: { mac: callerIdMac, model: null },
        router: null,
        warnings,
      };
    }
  }
}
