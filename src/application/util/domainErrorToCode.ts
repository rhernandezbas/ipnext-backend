import { DomainError } from '@domain/errors';
import { MissingRequiredFieldsError } from '@domain/errors/scheduling';
import { IClassRejectedError } from '@domain/errors/iclass';

/** Shape of a domain error mapped to a transport-agnostic result. */
export interface DomainErrorCode {
  errorCode: string;
  reason?: string;
  missingFields?: string[];
}

/**
 * Maps a domain error to its transport-agnostic `{ errorCode, reason?, missingFields? }`.
 * Single source of truth (AD-4) shared by the HTTP error handler (status mapping +
 * surfaced fields) and the bulk use-case (per-task `results[i]`).
 *
 * Any `DomainError` maps via its `.code`; `MissingRequiredFieldsError` and
 * `IClassRejectedError` add their extra fields. Non-domain errors return `null`.
 */
export function domainErrorToCode(err: unknown): DomainErrorCode | null {
  if (!(err instanceof DomainError)) return null;

  const result: DomainErrorCode = { errorCode: err.code };
  if (err instanceof MissingRequiredFieldsError) {
    result.missingFields = err.missingFields;
  }
  if (err instanceof IClassRejectedError) {
    result.reason = err.detail;
  }
  return result;
}
