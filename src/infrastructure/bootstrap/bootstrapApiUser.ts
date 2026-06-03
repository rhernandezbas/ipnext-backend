/**
 * bootstrapApiUser — idempotent seed of the system "Api" reporter (backlog #15).
 *
 * GR-ingested tasks must be reported by a stable system user ("Api"), not left
 * with a null reporter. This ensures a single RbacUser with login `api` exists so
 * `IngestGestionRealOrders` can stamp it as the task `reporterId`.
 *
 * The user is created `active` but with an UNUSABLE passwordHash (a bcrypt hash of
 * a random secret nobody knows), so it can never authenticate — it only exists to
 * be referenced as a reporter. Idempotent: if login `api` already exists, no-op
 * (the existing id is returned and the passwordHash is left untouched).
 *
 * Pure function — no process.env / no bcrypt inside, the hash is injected — so it
 * is composition-root-driven and trivially testable with InMemoryRbacUserRepository.
 */
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';

/** Stable login of the system reporter. Resolved by the ingest to set reporterId. */
export const API_USER_LOGIN = 'api';
export const API_USER_NAME = 'Api';
export const API_USER_EMAIL = 'api@sistema.local';

export interface BootstrapApiUserResult {
  outcome: 'created' | 'exists';
  /** Id of the system "Api" user — usable as a task reporterId. */
  id: string;
}

export async function bootstrapApiUser(
  userRepo: RbacUserRepository,
  opts: { passwordHash: string },
): Promise<BootstrapApiUserResult> {
  const existing = await userRepo.findByLogin(API_USER_LOGIN);
  if (existing) {
    return { outcome: 'exists', id: existing.id };
  }

  const user = await userRepo.create({
    name: API_USER_NAME,
    email: API_USER_EMAIL,
    login: API_USER_LOGIN,
    passwordHash: opts.passwordHash,
    status: 'active',
  });

  return { outcome: 'created', id: user.id };
}
