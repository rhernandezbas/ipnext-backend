/**
 * PortalAccount domain entity — customer-portal-api (Fase 1).
 *
 * The login credential of a final customer against `/api/portal/*`. 1 account <-> 1
 * Client (v1, `clientId` unique). `passwordHash` lives on the entity itself (unlike
 * RbacUser, which splits public fields from auth fields) — the DTO boundary in
 * `application/dto/portal/` is what strips it before anything reaches the wire, the
 * domain entity is not responsible for that filtering.
 *
 * Pure domain — zero external dependencies.
 */
export interface PortalAccount {
  id: string;
  clientId: string;
  dni: string;
  passwordHash: string;
  status: 'active' | 'disabled';
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}
