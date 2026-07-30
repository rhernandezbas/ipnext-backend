/**
 * portal-accounts-admin DTOs — customer-portal-api (Fase 3, task 3.1/3.2).
 *
 * Repo rule (`CLAUDE.md`): never return a Prisma/domain entity raw. Every wire
 * shape here is declared independently of `PortalAccount` (the domain entity),
 * even where the fields line up 1:1 today — the HTTP contract is pinned on its
 * own (same criterion as `portalAuth.dto.ts`). `passwordHash` NEVER appears on
 * any of these types — that's the whole point of the DTO boundary.
 */
import type { PortalAccount } from '@domain/entities/portalAccount';

export interface PortalAccountAdminDto {
  id: string;
  clientId: string;
  dni: string;
  status: 'active' | 'disabled';
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/admin/portal-accounts response — password shown ONCE, never again. */
export interface CreatePortalAccountResponseDto extends PortalAccountAdminDto {
  password: string;
}

/** POST /api/admin/portal-accounts/:id/regenerate-password response — same contract. */
export interface RegeneratePortalPasswordResponseDto extends PortalAccountAdminDto {
  password: string;
}

export interface PortalAccountListItemDto {
  id: string;
  clientId: string;
  clientName: string;
  dni: string;
  status: 'active' | 'disabled';
  lastLoginAt: string | null;
}

export interface PortalAccountListResponseDto {
  data: PortalAccountListItemDto[];
  total: number;
  page: number;
  limit: number;
}

/** Maps the domain entity to the admin DTO — strips `passwordHash`. */
export function toPortalAccountAdminDto(account: PortalAccount): PortalAccountAdminDto {
  return {
    id: account.id,
    clientId: account.clientId,
    dni: account.dni,
    status: account.status,
    mustChangePassword: account.mustChangePassword,
    lastLoginAt: account.lastLoginAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}
