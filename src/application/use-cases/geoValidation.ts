/**
 * Shared geolocation validation helpers.
 *
 * Used by UpdateClientLocation and UpdateContractLocation.
 * Throws InvalidLocationError on bad input; null/undefined are always allowed (clears the field).
 */
import { InvalidLocationError } from '@domain/errors/geolocation';

/**
 * OLC (Open Location Code / Plus Code) sane regex.
 * Accepts codes like "8FGC+23", "8FGC+234J", "87GCPMQR+7C", etc.
 * Characters come from the OLC alphabet: 23456789CFGHJMPQRVWX (case-insensitive).
 */
const PLUS_CODE_RE = /^[23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{2,3}$/i;

export function validateLat(lat: unknown): void {
  if (lat === null || lat === undefined) return;
  const n = Number(lat);
  if (!Number.isFinite(n) || n < -90 || n > 90) {
    throw new InvalidLocationError(`lat must be between -90 and 90, got: ${lat}`);
  }
}

export function validateLng(lng: unknown): void {
  if (lng === null || lng === undefined) return;
  const n = Number(lng);
  if (!Number.isFinite(n) || n < -180 || n > 180) {
    throw new InvalidLocationError(`lng must be between -180 and 180, got: ${lng}`);
  }
}

export function validatePlusCode(plusCode: unknown): void {
  if (plusCode === null || plusCode === undefined) return;
  if (typeof plusCode !== 'string' || !PLUS_CODE_RE.test(plusCode)) {
    throw new InvalidLocationError(
      `plusCode must be a valid Open Location Code (e.g. "8FGC+23"), got: ${plusCode}`,
    );
  }
}
