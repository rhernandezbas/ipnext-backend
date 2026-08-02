import { DomainError } from './index';

/**
 * wifi-self-service (F0) — errores de dominio del self-service de WiFi.
 * Codes → HTTP: las rutas los interceptan INLINE (mismo criterio que
 * `portal.errors.ts` / `CreatePortalTicket` route) — no dependen del
 * statusMap global, salvo `OltProvisioningError` (SMARTOLT_*), que sí lo usa.
 */

/**
 * El `contractId` recibido no existe O pertenece a OTRO cliente — UN SOLO
 * error para los dos casos (anti-IDOR, mismo criterio que
 * `PortalContractNotFoundError`): la ruta responde el MISMO 404 para "no
 * existe" y "es de otro cliente", nunca se filtra cuál de los dos pasó.
 */
export class WifiContractNotFoundError extends DomainError {
  constructor() {
    super('Contrato no encontrado', 'WIFI_CONTRACT_NOT_FOUND');
    this.name = 'WifiContractNotFoundError';
  }
}

export type WifiEligibilityReason = 'not_configured' | 'no_onu' | 'no_tr069' | 'no_wifi_ports';

/**
 * Regla "el server re-verifica en CADA escritura" (proposal.md regla 2): el
 * `PUT` re-corre `ResolveWifiEligibility` completo antes de aplicar el cambio.
 * Si la ONU dejó de ser elegible entre el GET y el PUT (p.ej. perdió TR-069),
 * la escritura se rechaza con este error — 409: el request está bien formado,
 * pero el ESTADO actual del sistema no lo permite.
 */
export class WifiNotEligibleError extends DomainError {
  constructor(public readonly reason: WifiEligibilityReason) {
    super(`El servicio de WiFi no está disponible para este contrato (${reason})`, 'WIFI_NOT_ELIGIBLE');
    this.name = 'WifiNotEligibleError';
  }
}

/** ssid/password fuera de los límites de forma (largo, chars de control, puerto inválido). */
export class WifiValidationError extends DomainError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'WifiValidationError';
  }
}
