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
 * external-bulk-messaging (D2) — thin wrapper over `bootstrapMachineUser` (the
 * generalized version of this exact logic). Kept as its own file/exports for
 * backcompat: every existing caller/test imports `bootstrapApiUser`/`API_USER_*`
 * from here unchanged. `bootstrapApiMessagingUser` (bootstrapApiMessagingUser.ts)
 * is the analogous wrapper for the `api-messaging` system user.
 */
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import { bootstrapMachineUser, BootstrapMachineUserResult } from './bootstrapMachineUser';

/** Stable login of the system reporter. Resolved by the ingest to set reporterId. */
export const API_USER_LOGIN = 'api';
export const API_USER_NAME = 'Api';
export const API_USER_EMAIL = 'api@sistema.local';

export type BootstrapApiUserResult = BootstrapMachineUserResult;

export async function bootstrapApiUser(
  userRepo: RbacUserRepository,
  opts: { passwordHash: string },
): Promise<BootstrapApiUserResult> {
  return bootstrapMachineUser(userRepo, {
    login: API_USER_LOGIN,
    name: API_USER_NAME,
    email: API_USER_EMAIL,
    passwordHash: opts.passwordHash,
  });
}
