import { DomainError } from './index';

/**
 * Zone domain errors.
 * Error codes are the wire contract; the route maps them to HTTP status codes:
 *   ZONE_NOT_FOUND    → 404
 *   INVALID_POLYGON   → 422
 */

/** The requested zone does not exist. */
export class ZoneNotFoundError extends DomainError {
  constructor(public readonly id: string) {
    super(`Zone ${id} not found`, 'ZONE_NOT_FOUND');
    this.name = 'ZoneNotFoundError';
  }
}

/**
 * The polygon is invalid. Causes:
 *  - fewer than 3 points
 *  - lat outside [-90, 90] or lng outside [-180, 180]
 *  - name is empty
 *  - color does not match #RGB or #RRGGBB
 */
export class InvalidPolygonError extends DomainError {
  constructor(reason: string) {
    super(reason, 'INVALID_POLYGON');
    this.name = 'InvalidPolygonError';
  }
}
