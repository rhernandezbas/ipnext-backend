/**
 * bootstrapSystemUsers — composition-root seed of the platform's system users.
 *
 * Today that is just the "Api" reporter (backlog #15): the stable RbacUser
 * (login `api`, unusable passwordHash → can never log in) referenced as the
 * author of machine-created records — GR-ingested tasks AND, from
 * external-create-ticket onward, tickets created through the external API.
 *
 * WHY THIS EXISTS (external-create-ticket T1): the "Api" user used to be seeded
 * ONLY from `bootstrapGestionRealIngest`, behind two early-returns (GR disabled /
 * missing creds). With Gestión Real being DEPRECATED, a machine reporter that
 * only exists when GR is ON is a latent bug — the day GR is turned off the
 * reporter vanishes and every machine-created record loses its author (the
 * external ticket endpoint would 500/orphan). This module runs UNCONDITIONALLY
 * from main.ts so the reporter always exists, GR or no GR.
 *
 * The repo + passwordHash are INJECTED (composition-root-driven, no process.env /
 * bcrypt inside) so it is trivially testable with the in-memory RbacUser repo.
 * Idempotent via bootstrapApiUser (no-op if login `api` already exists).
 */
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import { bootstrapApiUser } from './bootstrapApiUser';

export interface BootstrapSystemUsersResult {
  /** Id of the system "Api" reporter — usable as a ticket/task reporterId. */
  apiUserId: string;
}

export async function bootstrapSystemUsers(
  userRepo: RbacUserRepository,
  opts: { passwordHash: string },
): Promise<BootstrapSystemUsersResult> {
  const apiUser = await bootstrapApiUser(userRepo, { passwordHash: opts.passwordHash });
  console.log(`[bootstrap] system "Api" reporter ${apiUser.outcome} (id=${apiUser.id})`);
  return { apiUserId: apiUser.id };
}
