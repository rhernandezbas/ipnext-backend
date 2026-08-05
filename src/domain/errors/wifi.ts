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

/**
 * EPIC v3 (wifi de visitas) — la banda pedida NO tiene puerto de visita en el
 * template "ONU type" de SmartOLT (evidencia 2026-08-03: HWTCA92F96B1 expone
 * SOLO wifi_0/1..2 — sin 5GHz). 409, MISMO criterio que `WifiNotEligibleError`
 * (request bien formado, el ESTADO actual no lo permite): la ruta lo mapea
 * inline y el gateway JAMÁS se toca cuando esto se lanza.
 */
export class GuestBandUnavailableError extends DomainError {
  constructor(public readonly band: '2.4' | '5') {
    super(`El WiFi de visitas no está disponible en la banda ${band} para este equipo`, 'GUEST_BAND_UNAVAILABLE');
    this.name = 'GuestBandUnavailableError';
  }
}

/**
 * wifi-guest-pending — ya hay un cambio de la red de visitas EN CURSO
 * (`WifiGuestIntent` con edad < ventana de pending) para esta ONU: el alta
 * tarda ~2 min (TR-069 + cache) y la baja se verifica lazy — un segundo write
 * encimado pisaría el que está en vuelo. 409 con body FIJO
 * `{ error: 'guest_change_pending' }` (contrato con la app, la ruta lo emite
 * tal cual). Con el intent ya 'unconfirmed' (edad >= ventana) el write se
 * PERMITE y reemplaza el intent — este error no aplica.
 */
export class GuestChangePendingError extends DomainError {
  constructor() {
    super('Ya hay un cambio de la red de visitas en curso para este equipo', 'GUEST_CHANGE_PENDING');
    this.name = 'GuestChangePendingError';
  }
}

/** ssid/password fuera de los límites de forma (largo, chars de control, puerto inválido). */
export class WifiValidationError extends DomainError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'WifiValidationError';
  }
}
