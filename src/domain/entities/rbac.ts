/**
 * RBAC domain entities.
 *
 * Lives in the domain layer — zero external dependencies.
 * No Prisma, no Express, no Node I/O.
 */

// ---------------------------------------------------------------------------
// Known actions — source of truth for valid action codes (TS + runtime).
// DB stores action as VARCHAR(64); this list is the whitelist.
// 4 base + 24 sub-actions = 28 total.
// ---------------------------------------------------------------------------

/**
 * KNOWN_ACTIONS — all valid action codes.
 * This is the TS source-of-truth. The DB column is VARCHAR(64).
 * Adding new actions only requires extending this list (no ALTER TYPE).
 */
export const KNOWN_ACTIONS = [
  // Base actions (all modules)
  'read',
  'write',
  'delete',
  'manage',
  // tickets sub-actions
  'close',
  'reopen',
  // billing sub-actions
  'void',
  'send_email',
  // scheduling sub-actions
  'send_to_iclass',
  'bulk_delete',
  'move_stage',
  'manage_checklist',
  // monitoring sub-actions
  'acknowledge_alert',
  // network sub-actions
  'manage_gpon',
  'manage_sites',
  // iclass sub-actions
  'sync',
  'assign_to_project',
  // clients sub-actions
  'manage_documents',
  'manage_online_sessions',
  // admin sub-actions
  'view_activity_log',
  'manage_2fa',
  // rbac sub-actions
  'manage_users',
  'manage_user_roles',
  'change_user_password',
  'manage_roles',
  // profile sub-actions
  'change_own_password',
  // settings sub-actions
  'manage_api_tokens',
  'manage_backups',
] as const;

export type PermissionAction = (typeof KNOWN_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Module catalog (25 modules: 14 original + 11 new)
// ---------------------------------------------------------------------------

export const RBAC_MODULES = [
  // Original 14
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
  // New 11 (Phase 2)
  'voices',
  'partners',
  'rbac',
  'profile',
  'notifications',
  'dashboard',
  'portal',
  'search',
  'support',
  'sla',
  'tariffs',
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

/**
 * RbacPermissionCatalogEntry — read model for the permission catalog endpoint.
 *
 * Enriches a permission with its module's id + display label (joined from
 * RbacModule). A query projection, NOT a persisted entity — kept separate from
 * RbacPermission so the core entity stays free of FK/display concerns.
 */
export interface RbacPermissionCatalogEntry {
  id: string;
  moduleId: string;
  moduleCode: RbacModuleCode;
  moduleLabel: string;
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
