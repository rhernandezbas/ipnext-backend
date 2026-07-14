/**
 * RBAC domain entities.
 *
 * Lives in the domain layer — zero external dependencies.
 * No Prisma, no Express, no Node I/O.
 */

// ---------------------------------------------------------------------------
// Known actions — source of truth for valid action codes (TS + runtime).
// DB stores action as VARCHAR(64); this list is the whitelist.
// 4 base + 28 sub-actions = 32 total.
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
  'iclass_manual_resend', // T-26: reenvio manual a IClass con override de nodo
  'iclass_close',   // Ola A: cerrar OS de IClass desde Prominense
  'iclass_assign',  // Ola B: asignar cuadrilla a OS de IClass
  'hard_delete', // #86: DELETE total de tarea (solo super_admin)
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
  'view_sessions',
  'revoke_sessions',
  'flags',
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
  // tv sub-actions (#50) — granular Gigared TV operations (replace generic tv.write)
  'link',     // vincular/desvincular CIC (asociar internal_id)
  'register', // registrar/activar cuentas nuevas en el CUA
  'packs',    // agregar/quitar packs (servicios)
  'ott',      // habilitar/deshabilitar OTT (incl. suspender/reactivar)
  'cancel',   // dar de baja TV completa
  // tickets sub-actions (#85) — hard delete requires explicit permission
  'delete_hard',
  // pppoe sub-actions (Fase C) — corte de servicio (reduce/block/restore), separado de pppoe.manage
  'cut',
  // recapture sub-actions — bulk assignment (separate from recapture.manage)
  'assign',
  // service-transfer — transferir servicios entre clientes; Wave 1 lo usa el módulo tv
  // (tv.transfer); las waves 2-3 lo reusan para pppoe.transfer / inventory.transfer.
  'transfer',
  // messaging-inbox (F1) — responder un mensaje de WhatsApp/Chatwoot dentro de la ventana
  // 24h. Separado de 'read' porque leer el inbox no debe habilitar enviar (RBAC-2).
  'send',
  // messaging-bulk (F2) — disparar/ver campañas masivas + listar/usar templates
  'bulk',
  'templates',
] as const;
// NOTE: 'read' and 'manage' are already in KNOWN_ACTIONS (base actions).
// uisp module uses those base actions — no new action codes needed.

export type PermissionAction = (typeof KNOWN_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Module catalog (26 modules: 14 original + 11 new + 1 contracts)
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
  // contracts-page (service-technology change) — own permission module for contract/service views
  'contracts',
  // UISP mirror module — read-only mirror of UISP NMS data
  'uisp',
  // TV / Gigared integration module (#47) — read/manage base + granular ops (#50: link/register/packs/ott/cancel)
  'tv',
  // Recaptación / churned-client recovery (#80)
  'recapture',
  // PPPoE provisioning via RouterOS (#pppoe-service)
  'pppoe',
  // Internet speed plan catalog (plan-catalog)
  'plan',
  // Visual zones on the customer map (customer-zones-map)
  'zones',
  // Acciones / worklist operativo (actions-worklist) — casos de titularidad + bajas recientes
  'actions',
  // Inbox de mensajería omnicanal (messaging-inbox F1) — WhatsApp vía Chatwoot
  'messaging',
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
// Technical role codes (recapture-assignable-roles)
// ---------------------------------------------------------------------------

/**
 * Role codes considered "technical" — field/NOC-technician profiles that must
 * NOT receive recaptación (sales-recovery) leads. Only `tecnico` qualifies;
 * `noc` is intentionally NOT here (a NOC operator MAY receive leads).
 *
 * Single source of truth for the Recaptación assignee-pool exclusion, mirrored
 * on the FE (useAssignableOperators). Kept as its own list — separate from
 * SYSTEM_ROLES — so widening/narrowing the exclusion is a one-line change.
 */
export const TECHNICAL_ROLE_CODES = ['tecnico'] as const;

export type TechnicalRoleCode = (typeof TECHNICAL_ROLE_CODES)[number];

/**
 * True when a user's role-code set carries AT LEAST ONE technical role.
 *
 * - `['tecnico']`            → true
 * - `['ventas', 'tecnico']`  → true
 * - `['noc']`                → false
 * - `[]`                     → false (an empty set carries no technical role)
 *
 * NOTE: this checks ONLY the technical-role condition. The full "assignable"
 * rule (active AND has ≥1 role AND not technical) lives in the use case, which
 * also enforces the non-empty-roles requirement.
 */
export function isTechnicalRoleSet(codes: readonly string[]): boolean {
  return codes.some((c) => (TECHNICAL_ROLE_CODES as readonly string[]).includes(c));
}

// ---------------------------------------------------------------------------
// Domain interfaces
// ---------------------------------------------------------------------------

/**
 * RbacUser — domain entity.
 * Does NOT expose passwordHash (security boundary).
 * Does NOT expose failedLoginCount (auth-internal counter).
 * lockedUntil is display-safe: it tells the UI whether the account is locked
 * without revealing the auth failure details.
 */
export interface RbacUser {
  id: string;
  name: string;
  email: string;
  login: string;
  status: 'active' | 'disabled';
  /**
   * Soft FK to IClassTeam.login — persisted in RbacUser.iclassTeamLogin (AD-1).
   * Null = no cuadrilla mapeada. Set/cleared via SetTechnicianTeamMapping.
   */
  iclassTeamLogin?: string | null;
  /**
   * Mis clientes (Fase 2): nombre del vendedor en Gestión Real.
   * Soft mapping, nullable, sin FK física. Set/cleared via UpdateRbacUser.
   */
  grVendedorName?: string | null;
  /**
   * Account lockout expiry (ISO string) or null if not locked.
   * Display-safe: exposed in list/get so the admin UI can show the lock indicator.
   * Reset to null by UnlockRbacUser. NOT a security-sensitive field.
   */
  lockedUntil?: string | null;
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
