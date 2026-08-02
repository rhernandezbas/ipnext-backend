import { DomainError } from './index';

/**
 * portal-equipment-reboot — errores de dominio del self-service de reinicio de
 * equipo. Codes → HTTP: las rutas los interceptan INLINE (mismo criterio que
 * `wifi.ts`) — no dependen del statusMap global, salvo `OltProvisioningError`
 * (SMARTOLT_*), que sí lo usa.
 *
 * Diferencia CLAVE con `wifi.ts`: el reboot va por OMCI, NO por TR-069 — anda
 * incluso en un bridge sin puertos WiFi. La elegibilidad es MÁS AMPLIA que la
 * de "Mi WiFi": solo (1) el contrato es del cliente y (2) el serial de la ONU
 * activa resuelve en SmartOLT (`found:true`). Por eso `EquipmentRebootReason`
 * NO tiene `no_tr069` ni `no_wifi_ports` — esos dos ni se evalúan acá.
 */

/**
 * El `contractId` recibido no existe O pertenece a OTRO cliente — UN SOLO
 * error para los dos casos (anti-IDOR, mismo criterio que
 * `WifiContractNotFoundError`): la ruta responde el MISMO 404 para "no existe"
 * y "es de otro cliente", nunca se filtra cuál de los dos pasó.
 */
export class EquipmentContractNotFoundError extends DomainError {
  constructor() {
    super('Contrato no encontrado', 'EQUIPMENT_CONTRACT_NOT_FOUND');
    this.name = 'EquipmentContractNotFoundError';
  }
}

export type EquipmentRebootReason = 'not_configured' | 'no_onu';

/**
 * Regla "el server re-verifica en CADA escritura" (mismo criterio que
 * `WifiNotEligibleError`): `POST /reboot` re-corre `ResolveEquipmentRebootEligibility`
 * completo antes de disparar el reinicio. Si la ONU dejó de ser elegible entre
 * el GET y el POST (p.ej. desapareció de SmartOLT), el reinicio se rechaza con
 * este error — 409: el request está bien formado, pero el ESTADO actual no lo
 * permite.
 */
export class EquipmentNotEligibleError extends DomainError {
  constructor(public readonly reason: EquipmentRebootReason) {
    super(`El reinicio de equipo no está disponible para este contrato (${reason})`, 'EQUIPMENT_NOT_ELIGIBLE');
    this.name = 'EquipmentNotEligibleError';
  }
}
