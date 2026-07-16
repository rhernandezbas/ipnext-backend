import { DomainError } from './index';

/**
 * contract-node-ap-auto-assign (Fase B, PICK-1) — typed errors for
 * `SetContractNetworkAssignment` (the manual picker). All map to HTTP 422 — the contract
 * itself IS found (404 stays `ContractNotFoundError`, existing); these are validation
 * failures on the requested networkSiteId/accessPointId.
 */

/** The given `networkSiteId` does not exist in `NetworkSite`. Maps to 422. */
export class NetworkSiteNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Network site ${id} not found`, 'NETWORK_SITE_NOT_FOUND');
    this.name = 'NetworkSiteNotFoundError';
  }
}

/** The given `accessPointId` does not exist in `AccessPoint`. Maps to 422. */
export class AccessPointNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Access point ${id} not found`, 'ACCESS_POINT_NOT_FOUND');
    this.name = 'AccessPointNotFoundError';
  }
}

/**
 * The requested `accessPointId` has `missingSince != null` (the mirror marks it retired).
 * Manual assignment to a retired AP is rejected — unlike the AUTO assigner (design matriz
 * fila 9), the operator has no "live station" signal to override the retirement marker.
 * Maps to 422.
 */
export class AccessPointRetiredError extends DomainError {
  constructor(id: string) {
    super(`Access point ${id} is retired (missingSince is set) and cannot be assigned manually`, 'ACCESS_POINT_RETIRED');
    this.name = 'AccessPointRetiredError';
  }
}

/**
 * Both `networkSiteId` and `accessPointId` were given non-null, but the AP does not belong
 * to that site (`ap.networkSiteId !== networkSiteId`). Maps to 422.
 */
export class AccessPointNotInSiteError extends DomainError {
  constructor(accessPointId: string, networkSiteId: string) {
    super(`Access point ${accessPointId} does not belong to network site ${networkSiteId}`, 'ACCESS_POINT_NOT_IN_SITE');
    this.name = 'AccessPointNotInSiteError';
  }
}
