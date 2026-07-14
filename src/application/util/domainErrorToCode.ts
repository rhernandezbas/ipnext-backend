import { DomainError } from '@domain/errors';
import { MissingRequiredFieldsError } from '@domain/errors/scheduling';
import {
  IClassRejectedError,
  MissingIClassMappingError,
  IClassSoTypeInactiveError,
  IClassNodeNotAssignableError,
} from '@domain/errors/iclass';
import { MissingTemplateVariablesError } from '@domain/errors/messaging-bulk';

/** Shape of a domain error mapped to a transport-agnostic result. */
export interface DomainErrorCode {
  errorCode: string;
  reason?: string;
  missingFields?: string[];
  /** Surfaced from MissingIClassMappingError — the title of the unmapped project. */
  projectTitle?: string;
  /** Surfaced from IClassSoTypeInactiveError — the code of the inactive SO type. */
  iclassSoTypeCode?: string;
  /**
   * messaging-bulk (F2, CAMP-3) — surfaced from `MissingTemplateVariablesError`.
   * Spec.md names this wire field `missing` (NOT `missingFields` — a distinct,
   * pre-existing field used by a different feature); kept separate on purpose.
   */
  missing?: string[];
}

/**
 * Maps a domain error to its transport-agnostic `{ errorCode, reason?, missingFields?, ... }`.
 * Single source of truth (AD-4) shared by the HTTP error handler (status mapping +
 * surfaced fields) and the bulk use-case (per-task `results[i]`).
 *
 * Any `DomainError` maps via its `.code`; `MissingRequiredFieldsError`,
 * `IClassRejectedError`, `MissingIClassMappingError`, and `IClassSoTypeInactiveError`
 * add their extra fields. Non-domain errors return `null`.
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
  if (err instanceof IClassNodeNotAssignableError) {
    result.reason = err.reason;
  }
  if (err instanceof MissingIClassMappingError) {
    result.projectTitle = err.projectTitle;
  }
  if (err instanceof IClassSoTypeInactiveError) {
    result.iclassSoTypeCode = err.iclassSoTypeCode;
  }
  if (err instanceof MissingTemplateVariablesError) {
    result.missing = err.missing;
  }
  return result;
}
