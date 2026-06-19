/**
 * DTOs for RbacUser management (SDD #2).
 *
 * Security boundary: `passwordHash` is INTENTIONALLY absent from all output DTOs.
 * The mapper functions enumerate fields explicitly — no spread of raw entities.
 */

// ---------------------------------------------------------------------------
// Output DTOs
// ---------------------------------------------------------------------------

export interface RbacRoleDto {
  id: string;
  code: string;
  label: string;
  isSystem: boolean;
}

/**
 * Safe wire-shape for a user. MUST NOT expose passwordHash.
 */
export interface RbacUserDto {
  id: string;
  name: string;
  email: string;
  login: string;
  status: 'active' | 'disabled';
  /** Mis clientes (Fase 2): nombre del vendedor en Gestión Real. null = sin mapear. */
  grVendedorName: string | null;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export interface RbacUserWithRolesDto extends RbacUserDto {
  roles: RbacRoleDto[];
}

// ---------------------------------------------------------------------------
// Input DTOs
// ---------------------------------------------------------------------------

export interface CreateRbacUserDto {
  name: string;
  email: string;
  login: string;
  /** Plaintext — hashed in the use case via PasswordHasher port. */
  password: string;
  status?: 'active' | 'disabled';
  /** Length >= 1, enforced by CreateRbacUser use case. */
  roleIds: string[];
}

export interface UpdateRbacUserDto {
  name?: string;
  email?: string;
  login?: string;
  status?: 'active' | 'disabled';
  /**
   * Optional password change.
   * - Absent or empty string → no password change.
   * - Non-empty string → validated (>= 8 chars) and hashed.
   */
  password?: string;
  /**
   * Mis clientes (Fase 2): nombre del vendedor en GR.
   * - undefined → no change.
   * - null → clears the mapping.
   * - string → sets the mapping.
   */
  grVendedorName?: string | null;
}

export interface ChangeRbacUserPasswordDto {
  newPassword: string;
  /** Required for self-change; omitted for admin-managed change. */
  oldPassword?: string;
}

// ---------------------------------------------------------------------------
// Mappers — single source of truth for the security boundary
// ---------------------------------------------------------------------------

/**
 * Maps any object with the required fields to RbacUserDto.
 * Explicitly enumerates fields — unknown extra fields (including passwordHash)
 * are dropped, never passed to the wire.
 */
export function toRbacUserDto(u: {
  id: string;
  name: string;
  email: string;
  login: string;
  status: 'active' | 'disabled';
  grVendedorName?: string | null;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}): RbacUserDto {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    login: u.login,
    status: u.status,
    grVendedorName: u.grVendedorName ?? null,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    lastLoginAt: u.lastLoginAt,
  };
}

export function toRbacRoleDto(r: {
  id: string;
  code: string;
  label: string;
  isSystem: boolean;
}): RbacRoleDto {
  return { id: r.id, code: r.code, label: r.label, isSystem: r.isSystem };
}

export function toRbacUserWithRolesDto(
  u: Parameters<typeof toRbacUserDto>[0],
  roles: Parameters<typeof toRbacRoleDto>[0][],
): RbacUserWithRolesDto {
  return {
    ...toRbacUserDto(u),
    roles: roles.map(toRbacRoleDto),
  };
}
