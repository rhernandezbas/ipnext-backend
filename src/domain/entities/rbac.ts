/**
 * RBAC domain entities.
 *
 * Lives in the domain layer — zero external dependencies.
 * No Prisma, no Express, no Node I/O.
 */

// ---------------------------------------------------------------------------
// Action union
// ---------------------------------------------------------------------------

export type PermissionAction = 'read' | 'write' | 'delete' | 'manage';

// ---------------------------------------------------------------------------
// Module catalog (14 modules — locked in architecture decision #1)
// ---------------------------------------------------------------------------

export const RBAC_MODULES = [
  'clients',
  'billing',
  'scheduling',
  'network',
  'admin',
  'monitoring',
  'iclass',
  'gestionReal',
  'reports',
  'tickets',
  'settings',
  'crm',
  'inventory',
  'vehicles',
] as const;

export type RbacModuleCode = (typeof RBAC_MODULES)[number];

// ---------------------------------------------------------------------------
// System role codes (6 roles — locked in architecture decision #3)
// ---------------------------------------------------------------------------

export const SYSTEM_ROLES = [
  'super_admin',
  'administrador',
  'administracion',
  'ventas',
  'noc',
  'tecnico',
] as const;

export type SystemRoleCode = (typeof SYSTEM_ROLES)[number];

// ---------------------------------------------------------------------------
// Domain interfaces
// ---------------------------------------------------------------------------

/**
 * RbacUser — domain entity.
 * Does NOT expose passwordHash (security boundary).
 */
export interface RbacUser {
  id: string;
  name: string;
  email: string;
  login: string;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

/**
 * RbacRole — domain entity.
 */
export interface RbacRole {
  id: string;
  code: string;
  label: string;
  isSystem: boolean;
}

/**
 * RbacModule — domain entity.
 */
export interface RbacModule {
  id: string;
  code: RbacModuleCode;
  label: string;
}

/**
 * RbacPermission — domain entity.
 * References moduleCode (not moduleId) — keeps the domain free of FK concerns.
 */
export interface RbacPermission {
  id: string;
  moduleCode: RbacModuleCode;
  action: PermissionAction;
}

// ---------------------------------------------------------------------------
// Pivot entity shapes (used as type witnesses in port contract tests)
// ---------------------------------------------------------------------------

export interface RbacUserRole {
  userId: string;
  roleId: string;
}

export interface RbacRolePermission {
  roleId: string;
  permissionId: string;
}
