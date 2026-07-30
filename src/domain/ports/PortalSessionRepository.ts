/**
 * PortalSessionRepository — domain port (customer-portal-api Fase 1).
 *
 * Lives in the domain layer. Zero imports from @infrastructure/* or Prisma.
 */
import type { PortalSession } from '../entities/portalSession';

export interface CreatePortalSessionInput {
  accountId: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface PortalSessionRepository {
  create(input: CreatePortalSessionInput): Promise<PortalSession>;
  /**
   * Returns the session for this token hash in WHATEVER state it is (revoked,
   * rotated, expired, or usable) — `RefreshPortalSession` needs the raw state to
   * tell "unknown token" apart from "reused token" (theft signal) apart from
   * "expired/revoked". Callers apply `portalSession.policy.ts` on the result.
   */
  findByTokenHash(tokenHash: string): Promise<PortalSession | null>;
  /**
   * Marks the session as consumed by a rotation — a refresh is single-use.
   *
   * H2 (fix wave): ATOMIC compare-and-swap. Returns `true` only when THIS call
   * transitioned `rotatedAt` from null (exactly one row updated); `false` when
   * the session was already rotated (or doesn't exist) — i.e. a concurrent
   * refresh won the race. Callers MUST treat `false` as token reuse (theft
   * signal), never as success: two concurrent refreshes of the same token must
   * never mint two live chains.
   */
  markRotated(id: string): Promise<boolean>;
  revoke(id: string): Promise<void>;
  /** Revokes every non-revoked session of the account; returns how many were revoked. */
  revokeAllForAccount(accountId: string): Promise<number>;
  /**
   * customer-portal-api (Fase 6, task 6.1) — portal-account-deletion spec
   * "Borrado in-app": hard-deletes EVERY session row of the account (not a
   * revoke — the rows themselves disappear, no hashed tokens left behind).
   * Called by `DeleteMyPortalAccount` BEFORE deleting the `PortalAccount`.
   * Idempotent: returns how many rows were deleted (0 when the account had
   * none). In Postgres this is also covered by `PortalSession.account`'s
   * `onDelete: Cascade`, but the use case deletes explicitly rather than
   * relying on a hidden DB cascade — same behavior on every adapter
   * (in-memory has no FK cascade to fall back on).
   */
  deleteAllForAccount(accountId: string): Promise<number>;
}
