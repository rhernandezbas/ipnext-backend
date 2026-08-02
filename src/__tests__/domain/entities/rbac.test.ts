/**
 * Phase 1.1 / Phase 2.4 — Entity shape tests for RBAC domain types.
 * Phase 2: updated to assert 25 modules and 28 known actions.
 * service-technology change: added 'contracts' module → 26 total.
 * uisp-integration change: added 'uisp' module → 27 total.
 * messaging-inbox (F1): added 'messaging' module → 34 total; added 'send' action → 45 total.
 * messaging-bulk (F2): added 'bulk' + 'templates' actions → 47 total.
 */
import {
  PermissionAction,
  RbacModuleCode,
  SystemRoleCode,
  RBAC_MODULES,
  SYSTEM_ROLES,
  KNOWN_ACTIONS,
  TECHNICAL_ROLE_CODES,
  isTechnicalRoleSet,
  RbacUser,
  RbacRole,
  RbacModule,
  RbacPermission,
  RbacUserRole,
  RbacRolePermission,
} from '../../../domain/entities/rbac';

describe('RBAC_MODULES constant', () => {
  // Resolución de merge (finance-growth-dashboard ⨯ ai-assistant-multiagent, 2026-07-26):
  // los dos changes se construyeron en paralelo y CADA UNO afirmaba 36 porque contaba su
  // propio módulo sobre una base de 35. Mergeados, la realidad son 37 — verificado contando
  // las entradas reales de `RBAC_MODULES` (sin duplicados). Se conservan las DOS aserciones
  // de módulo: quedarse con una sola habría dejado el otro módulo sin pin.
  //
  // Resolución de merge (iclass-gps-audit ⨯ main, 2026-07-27): mismo patrón otra vez.
  // `technicians` se construyó en paralelo sobre la misma base de 35 y afirmaba 36.
  // Unidos los tres módulos (assistant + finance + technicians) sobre esa base, el
  // conteo REAL es 38 — verificado contando las entradas del array, no sumando.
  // Se conservan las TRES aserciones `toContain`: cada módulo mantiene su propio pin.
  //
  // portal-promos (2026-08-02): agrega el módulo `promos` sobre esa base de 38 -> 39.
  // portal-push-notifications: agrega el módulo `push` sobre esa base de 39 -> 40.
  // wifi-self-service (F0): agrega el módulo `wifi` sobre esa base de 40 -> 41.
  it('contains exactly 41 module codes (14 original + 11 Phase 2 + 1 contracts + 1 uisp + 1 tv + 1 recapture + 1 pppoe + 1 plan + 1 zones + 1 actions + 1 messaging + 1 news + 1 assistant + 1 finance + 1 technicians + 1 promos + 1 push + 1 wifi)', () => {
    expect(RBAC_MODULES).toHaveLength(41);
  });

  it('includes the wifi module (wifi-self-service)', () => {
    // Módulo PROPIO: wifi.manage cambia la contraseña del WiFi del cliente y
    // dispara TR-069 — riesgo/alcance propio, separado de `network`/`iclass`.
    expect(RBAC_MODULES).toContain('wifi');
  });

  it('includes the assistant module (ai-assistant-multiagent)', () => {
    // Módulo PROPIO y no una sub-acción de `messaging`: responder un WhatsApp y configurar
    // un bot que responde solo, a escala y sin supervisión, son responsabilidades distintas.
    expect(RBAC_MODULES).toContain('assistant');
  });

  it('includes technicians (iclass-gps-audit — ubicación y auditoría de presencia de cuadrillas)', () => {
    expect(RBAC_MODULES).toContain('technicians');
  });

  it('includes the promos module (portal-promos — promociones publicadas en la app de clientes)', () => {
    expect(RBAC_MODULES).toContain('promos');
  });

  it('includes the push module (portal-push-notifications — envío de avisos de servicio push)', () => {
    expect(RBAC_MODULES).toContain('push');
  });

  it('includes all 14 original module codes', () => {
    const original = [
      'clients', 'billing', 'scheduling', 'network', 'admin', 'monitoring',
      'iclass', 'gestionReal', 'reports', 'tickets', 'settings', 'crm',
      'inventory', 'vehicles',
    ];
    for (const code of original) {
      expect(RBAC_MODULES).toContain(code);
    }
  });

  it('includes all 11 new Phase 2 module codes', () => {
    const newModules = [
      'voices', 'partners', 'rbac', 'profile', 'notifications',
      'dashboard', 'portal', 'search', 'support', 'sla', 'tariffs',
    ];
    for (const code of newModules) {
      expect(RBAC_MODULES).toContain(code);
    }
  });

  it('includes the contracts module (service-technology change)', () => {
    expect(RBAC_MODULES).toContain('contracts');
  });

  it('includes the uisp module (uisp-integration change)', () => {
    expect(RBAC_MODULES).toContain('uisp');
  });

  it('includes the tv module (gigared-integration change #47)', () => {
    expect(RBAC_MODULES).toContain('tv');
  });

  it('includes the pppoe module (#pppoe-service Fase B)', () => {
    expect(RBAC_MODULES).toContain('pppoe');
  });

  it('includes the plan module (plan-catalog)', () => {
    expect(RBAC_MODULES).toContain('plan');
  });

  it('includes the actions module (actions-worklist — worklist de titularidad + bajas)', () => {
    expect(RBAC_MODULES).toContain('actions');
  });

  it('includes the messaging module (messaging-inbox F1 — inbox WhatsApp/Chatwoot)', () => {
    expect(RBAC_MODULES).toContain('messaging');
  });

  it('includes the news module (internal-news — tablón interno del equipo)', () => {
    expect(RBAC_MODULES).toContain('news');
  });

  it('includes the finance module (finance-growth Fase 1 — separado de billing, deliberadamente)', () => {
    expect(RBAC_MODULES).toContain('finance');
  });

  it('is readonly (as const)', () => {
    // Type-level check: RbacModuleCode is a union of the 28 values
    const code: RbacModuleCode = 'clients';
    expect(code).toBe('clients');
  });
});

describe('SYSTEM_ROLES constant', () => {
  it('contains exactly 6 system role codes', () => {
    expect(SYSTEM_ROLES).toHaveLength(6);
  });

  it('includes all expected system role codes', () => {
    const expected = [
      'super_admin', 'administrador', 'administracion', 'ventas', 'noc', 'tecnico',
    ];
    expect([...SYSTEM_ROLES]).toEqual(expected);
  });

  it('is readonly (as const)', () => {
    const code: SystemRoleCode = 'super_admin';
    expect(code).toBe('super_admin');
  });
});

describe('TECHNICAL_ROLE_CODES + isTechnicalRoleSet (recapture-assignable-roles)', () => {
  it('TECHNICAL_ROLE_CODES contains exactly ["tecnico"]', () => {
    expect([...TECHNICAL_ROLE_CODES]).toEqual(['tecnico']);
  });

  it('isTechnicalRoleSet(["tecnico"]) → true (the set carries a technical role)', () => {
    expect(isTechnicalRoleSet(['tecnico'])).toBe(true);
  });

  it('isTechnicalRoleSet(["noc"]) → false (noc is NOT technical)', () => {
    expect(isTechnicalRoleSet(['noc'])).toBe(false);
  });

  it('isTechnicalRoleSet([]) → false (empty set carries no technical role)', () => {
    expect(isTechnicalRoleSet([])).toBe(false);
  });

  it('isTechnicalRoleSet is true when tecnico appears alongside other roles', () => {
    expect(isTechnicalRoleSet(['ventas', 'tecnico'])).toBe(true);
  });

  it('isTechnicalRoleSet is false for a non-technical multi-role set', () => {
    expect(isTechnicalRoleSet(['ventas', 'noc', 'administrador'])).toBe(false);
  });
});

describe('PermissionAction type', () => {
  it('accepts all 4 base action strings', () => {
    const actions: PermissionAction[] = ['read', 'write', 'delete', 'manage'];
    expect(actions).toHaveLength(4);
    expect(actions).toContain('read');
    expect(actions).toContain('write');
    expect(actions).toContain('delete');
    expect(actions).toContain('manage');
  });
});

describe('KNOWN_ACTIONS constant', () => {
  // Resolución de merge (iclass-gps-audit ⨯ main, 2026-07-27): finance-growth sumó 3
  // acciones (manage_costs/manage_targets/manage_inflation) y iclass-gps-audit sumó 2
  // (location_read/location_audit), ambos sobre la misma base de 53. Unidas las cinco,
  // el conteo REAL es 58 — verificado contando el array, sin duplicados.
  it('contains exactly 58 valid action codes (53 prior + 3 finance-growth Fase 1: manage_costs/manage_targets/manage_inflation — `sync` already existed, reused — + 2 iclass-gps-audit: location_read/location_audit)', () => {
    expect(KNOWN_ACTIONS).toHaveLength(58);
  });

  it('includes the 3 finance-growth Fase 1 sub-actions (manage_costs/manage_targets/manage_inflation)', () => {
    expect(KNOWN_ACTIONS).toContain('manage_costs');
    expect(KNOWN_ACTIONS).toContain('manage_targets');
    expect(KNOWN_ACTIONS).toContain('manage_inflation');
  });

  it('includes location_read and location_audit as SEPARATE actions (iclass-gps-audit)', () => {
    // Son dos a propósito: el mapa en vivo (despacho) NO debe arrastrar la auditoría
    // histórica de una persona. Si alguien las colapsa en una sola, este test cae.
    expect(KNOWN_ACTIONS).toContain('location_read');
    expect(KNOWN_ACTIONS).toContain('location_audit');
    expect(KNOWN_ACTIONS.filter((a) => a.startsWith('location_'))).toHaveLength(2);
  });

  it("includes bulk (messaging-bulk F2 — disparar/ver campañas masivas)", () => {
    expect(KNOWN_ACTIONS).toContain('bulk');
  });

  it('includes the 6 bulk-granular-perms actions (envío masivo por estado de cliente + números)', () => {
    const granular = ['bulk_active', 'bulk_late', 'bulk_blocked', 'bulk_inactive', 'bulk_baja', 'bulk_numbers'];
    for (const action of granular) {
      expect(KNOWN_ACTIONS).toContain(action);
    }
  });

  it("includes templates (messaging-bulk F2 — listar/usar templates de WhatsApp)", () => {
    expect(KNOWN_ACTIONS).toContain('templates');
  });

  it('includes transfer (service-transfer — transferir servicios entre clientes: tv.transfer hoy, pppoe/inventory en waves 2-3)', () => {
    expect(KNOWN_ACTIONS).toContain('transfer');
  });

  it('includes send (messaging-inbox F1 — responder un mensaje dentro de la ventana 24h, RBAC-2)', () => {
    expect(KNOWN_ACTIONS).toContain('send');
  });

  it('includes scheduling.hard_delete (#86 — super_admin-only hard delete of tasks)', () => {
    expect(KNOWN_ACTIONS).toContain('hard_delete');
  });

  it('includes pppoe.cut (Fase C — corte de servicio)', () => {
    expect(KNOWN_ACTIONS).toContain('cut');
  });

  it('includes recapture.assign (bulk assignment permission)', () => {
    expect(KNOWN_ACTIONS).toContain('assign');
  });

  it('includes all 4 base actions', () => {
    expect(KNOWN_ACTIONS).toContain('read');
    expect(KNOWN_ACTIONS).toContain('write');
    expect(KNOWN_ACTIONS).toContain('delete');
    expect(KNOWN_ACTIONS).toContain('manage');
  });

  it('includes all 28 sub-action codes from spec (admin.flags + view_sessions + revoke_sessions added)', () => {
    const subActions = [
      // tickets
      'close', 'reopen',
      // billing
      'void', 'send_email',
      // scheduling
      'send_to_iclass', 'bulk_delete', 'move_stage', 'manage_checklist',
      'iclass_manual_resend', // T-26: reenvio manual a IClass
      // monitoring
      'acknowledge_alert',
      // network
      'manage_gpon', 'manage_sites',
      // iclass
      'sync', 'assign_to_project',
      // clients
      'manage_documents', 'manage_online_sessions',
      // admin
      'view_activity_log', 'manage_2fa', 'view_sessions', 'revoke_sessions', 'flags',
      // rbac
      'manage_users', 'manage_user_roles', 'change_user_password', 'manage_roles',
      // profile
      'change_own_password',
      // settings
      'manage_api_tokens', 'manage_backups',
    ];
    expect(subActions).toHaveLength(28);
    for (const action of subActions) {
      expect(KNOWN_ACTIONS).toContain(action);
    }
  });

  it('includes the 5 tv granular sub-actions (#50 — Gigared TV granular permissions)', () => {
    const tvGranular: PermissionAction[] = ['link', 'register', 'packs', 'ott', 'cancel'];
    for (const action of tvGranular) {
      expect(KNOWN_ACTIONS).toContain(action);
    }
  });

  it('includes delete_hard (#85 — hard delete tickets requires explicit permission)', () => {
    expect(KNOWN_ACTIONS).toContain('delete_hard');
  });

  it('includes iclass_close + iclass_assign (iclass-os-actions Ola A + B — super_admin only)', () => {
    expect(KNOWN_ACTIONS).toContain('iclass_close');
    expect(KNOWN_ACTIONS).toContain('iclass_assign');
  });

  it('tv granular actions resolve to dot-format wire keys (tv.<action>)', () => {
    // The wire key is built as `${moduleCode}.${action}` in ResolveUserPermissions.ts:69
    const tvModule = 'tv';
    const expected = ['tv.link', 'tv.register', 'tv.packs', 'tv.ott', 'tv.cancel'];
    const granularActions: PermissionAction[] = ['link', 'register', 'packs', 'ott', 'cancel'];
    const wireKeys = granularActions.map((a) => `${tvModule}.${a}`);
    expect(wireKeys).toEqual(expected);
  });

  it('is exported as KNOWN_ACTIONS (source-of-truth for valid action codes)', () => {
    // TS-level: KNOWN_ACTIONS[number] = PermissionAction
    const action: PermissionAction = 'close';
    expect(action).toBe('close');
  });
});

describe('RbacUser entity shape', () => {
  it('holds all required fields without passwordHash', () => {
    const user: RbacUser = {
      id: 'u-1',
      name: 'John Doe',
      email: 'jdoe@example.com',
      login: 'jdoe',
      status: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      lastLoginAt: null,
    };
    expect(user.id).toBe('u-1');
    expect(user.login).toBe('jdoe');
    expect(user.status).toBe('active');
    expect(user.lastLoginAt).toBeNull();
    // passwordHash must NOT be present in domain entity
    expect('passwordHash' in user).toBe(false);
  });

  it('accepts disabled status', () => {
    const user: RbacUser = {
      id: 'u-2',
      name: 'Disabled User',
      email: 'disabled@example.com',
      login: 'disabled',
      status: 'disabled',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      lastLoginAt: null,
    };
    expect(user.status).toBe('disabled');
  });
});

describe('RbacRole entity shape', () => {
  it('holds all required fields', () => {
    const role: RbacRole = {
      id: 'r-1',
      code: 'super_admin',
      label: 'Super Admin',
      isSystem: true,
    };
    expect(role.code).toBe('super_admin');
    expect(role.isSystem).toBe(true);
  });

  it('accepts non-system roles', () => {
    const role: RbacRole = {
      id: 'r-2',
      code: 'custom_role',
      label: 'Custom Role',
      isSystem: false,
    };
    expect(role.isSystem).toBe(false);
  });
});

describe('RbacModule entity shape', () => {
  it('holds all required fields with typed code', () => {
    const mod: RbacModule = {
      id: 'm-1',
      code: 'clients',
      label: 'Clients',
    };
    expect(mod.code).toBe('clients');
    expect(mod.label).toBe('Clients');
  });
});

describe('RbacPermission entity shape', () => {
  it('holds id, moduleCode and action', () => {
    const perm: RbacPermission = {
      id: 'p-1',
      moduleCode: 'billing',
      action: 'read',
    };
    expect(perm.moduleCode).toBe('billing');
    expect(perm.action).toBe('read');
  });

  it('accepts manage action', () => {
    const perm: RbacPermission = {
      id: 'p-2',
      moduleCode: 'admin',
      action: 'manage',
    };
    expect(perm.action).toBe('manage');
  });
});

describe('RbacUserRole pivot entity shape', () => {
  it('holds userId and roleId', () => {
    const pivot: RbacUserRole = {
      userId: 'u-1',
      roleId: 'r-1',
    };
    expect(pivot.userId).toBe('u-1');
    expect(pivot.roleId).toBe('r-1');
  });
});

describe('RbacRolePermission pivot entity shape', () => {
  it('holds roleId and permissionId', () => {
    const pivot: RbacRolePermission = {
      roleId: 'r-1',
      permissionId: 'p-1',
    };
    expect(pivot.roleId).toBe('r-1');
    expect(pivot.permissionId).toBe('p-1');
  });
});
