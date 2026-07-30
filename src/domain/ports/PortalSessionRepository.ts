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
  /** Marks the session as consumed by a rotation — a refresh is single-use. */
  markRotated(id: string): Promise<void>;
  revoke(id: string): Promise<void>;
  /** Revokes every non-revoked session of the account; returns how many were revoked. */
  revokeAllForAccount(accountId: string): Promise<number>;
}
