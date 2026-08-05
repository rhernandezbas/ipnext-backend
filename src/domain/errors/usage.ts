import { DomainError } from './index';

/**
 * portal-usage-metrics — errores de dominio de "Mi consumo".
 *
 * UN SOLO error para "el contrato no existe" y "el contrato es de OTRO cliente"
 * (anti-IDOR estructural, mismo criterio que `EquipmentContractNotFoundError` y
 * `WifiContractNotFoundError`): la ruta responde el MISMO 404 en los dos casos,
 * nunca se filtra cuál de los dos pasó. La ruta lo intercepta INLINE.
 *
 * Ojo con lo que NO es un error acá: "el contrato no tiene PPPoE" y "no hubo
 * sesiones este mes" son ESTADOS NORMALES — 200 con `available:false` (mismo
 * criterio que la elegibilidad WiFi), jamás una excepción.
 */
export class UsageContractNotFoundError extends DomainError {
  constructor() {
    super('Contrato no encontrado', 'USAGE_CONTRACT_NOT_FOUND');
    this.name = 'UsageContractNotFoundError';
  }
}
