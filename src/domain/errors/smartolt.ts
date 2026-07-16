import { DomainError } from './index';

/**
 * smartolt-provision (K2) — errores tipados del aprovisionamiento de ONUs fibra.
 * Codes = wire contract; el errorHandler global los mapea vía statusMap:
 *   SMARTOLT_NOT_CONFIGURED → 503   SMARTOLT_UNREACHABLE → 502   SMARTOLT_REJECTED → 422
 *   ONU_NOT_HUAWEI → 422   FIBER_VLAN_REQUIRED → 422   ONU_NOT_FOUND → 404
 *   SMARTOLT_OLT_NOT_FOUND → 404
 */

export type OltProvisioningFailureReason = 'not_configured' | 'unreachable' | 'rejected';

const REASON_CODES: Record<OltProvisioningFailureReason, string> = {
  not_configured: 'SMARTOLT_NOT_CONFIGURED',
  unreachable: 'SMARTOLT_UNREACHABLE',
  rejected: 'SMARTOLT_REJECTED',
};

/**
 * Falla del plano SmartOLT, con `reason` tipado:
 *  - 'not_configured' → envs SMARTOLT_BASE_URL/SMARTOLT_API_TOKEN ausentes (opt-in apagado)
 *  - 'unreachable'    → red caída / timeout / 5xx (SmartOLT no respondió)
 *  - 'rejected'       → SmartOLT respondió y RECHAZÓ (status false / response_code / 4xx)
 */
export class OltProvisioningError extends DomainError {
  constructor(
    public readonly reason: OltProvisioningFailureReason,
    public readonly detail: string,
  ) {
    super(detail, REASON_CODES[reason]);
    this.name = 'OltProvisioningError';
  }
}

/** Solo Huawei (SN prefijo HWTC) se auto-aprovisiona — decisión K2. */
export class OnuNotHuaweiError extends DomainError {
  constructor(public readonly sn: string) {
    super(
      `La ONU '${sn}' no es Huawei (prefijo HWTC) — solo Huawei se auto-aprovisiona`,
      'ONU_NOT_HUAWEI',
    );
    this.name = 'OnuNotHuaweiError';
  }
}

/**
 * Sin VLAN: ni el input la trae ni el catálogo del OLT tiene default
 * (CHIVILCOY X2: VLAN heterogénea por cliente — el operador DEBE elegirla).
 */
export class FiberVlanRequiredError extends DomainError {
  constructor(public readonly smartoltOltId: string) {
    super(
      `La OLT ${smartoltOltId} no tiene VLAN de servicio default — indicá la VLAN en el request`,
      'FIBER_VLAN_REQUIRED',
    );
    this.name = 'FiberVlanRequiredError';
  }
}

/** El SN pedido no aparece en la lista de ONUs sin configurar de SmartOLT. */
export class UnconfiguredOnuNotFoundError extends DomainError {
  constructor(public readonly sn: string) {
    super(
      `La ONU '${sn}' no está en la lista de ONUs sin configurar de SmartOLT`,
      'ONU_NOT_FOUND',
    );
    this.name = 'UnconfiguredOnuNotFoundError';
  }
}

/** No existe la fila del catálogo SmartOltOltConfig pedida (PUT /olts/:id). */
export class SmartOltOltConfigNotFoundError extends DomainError {
  constructor(public readonly id: string) {
    super(`SmartOltOltConfig ${id} not found`, 'SMARTOLT_OLT_NOT_FOUND');
    this.name = 'SmartOltOltConfigNotFoundError';
  }
}
