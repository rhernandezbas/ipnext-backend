# Spec: rbac-permission-catalog-extension

## Capability
Additive migration that:
1. Migrates `RbacPermission.action` from the `RbacAction` enum to `VARCHAR(64)`.
2. Inserts 11 new `RbacModule` rows.
3. Inserts base permissions (4 × 11 modules = 44 rows) + sub-action permissions (~24 rows).
4. Grants all new permissions to the `super_admin` role.
5. Updates domain entities/types to reflect the open action type.

---

## Context

- SDD #1 created `RbacAction` enum with values `(read, write, delete, manage)`.
- Adding a new sub-action today requires `ALTER TYPE rbacaction ADD VALUE` (DDL
  statement that cannot run inside a transaction in Postgres). This blocks
  iterative catalog growth.
- Decision: migrate to `VARCHAR(64)` with a TS whitelist in code (locked in
  decisions observation #391).
- Migration timestamp: post `20260529100000_task_fk_admin_to_rbacuser` →
  use `20260530000000_rbac_permission_catalog_extension`.

---

## Migration steps (single transaction)

### Step 1 — ALTER column type
```sql
-- Drop the default if any, then alter type
ALTER TABLE "RbacPermission"
  ALTER COLUMN "action" TYPE VARCHAR(64)
  USING "action"::text;
```

After this, `RbacAction` enum may have no other users. Drop it:
```sql
DROP TYPE IF EXISTS "RbacAction";
```

Verify no other tables reference `RbacAction` before dropping. From codebase
scan: only `RbacPermission.action` uses it. Safe to drop.

### Step 2 — Insert 11 new modules
```sql
INSERT INTO "RbacModule" (id, code, label)
VALUES
  (gen_random_uuid(), 'voices',        'Voz / VoIP'),
  (gen_random_uuid(), 'partners',      'Resellers / Partners'),
  (gen_random_uuid(), 'rbac',          'Roles y Permisos'),
  (gen_random_uuid(), 'profile',       'Perfil de usuario'),
  (gen_random_uuid(), 'notifications', 'Notificaciones'),
  (gen_random_uuid(), 'dashboard',     'Panel de control'),
  (gen_random_uuid(), 'portal',        'Portal de clientes'),
  (gen_random_uuid(), 'search',        'Búsqueda global'),
  (gen_random_uuid(), 'support',       'Soporte / Mensajes'),
  (gen_random_uuid(), 'sla',           'SLA'),
  (gen_random_uuid(), 'tariffs',       'Tarifas')
ON CONFLICT (code) DO NOTHING;
```

`RbacModule` must have a UNIQUE constraint on `code`. If missing, add one:
```sql
ALTER TABLE "RbacModule" ADD CONSTRAINT "RbacModule_code_key" UNIQUE (code);
```
(Check if already present from SDD #1 migration before adding.)

### Step 3 — Insert base permissions for ALL 25 modules
Insert 4 base actions (read, write, delete, manage) for each of the 11 NEW
modules only (14 existing modules already have theirs from SDD #1):

```sql
INSERT INTO "RbacPermission" (id, "moduleId", action)
SELECT gen_random_uuid(), m.id, a.action
FROM "RbacModule" m
CROSS JOIN (VALUES ('read'),('write'),('delete'),('manage')) AS a(action)
WHERE m.code IN (
  'voices','partners','rbac','profile','notifications',
  'dashboard','portal','search','support','sla','tariffs'
)
ON CONFLICT ("moduleId", action) DO NOTHING;
```

`RbacPermission` must have UNIQUE constraint on `(moduleId, action)`.

### Step 4 — Insert sub-action permissions (locked list)

```sql
-- Helper: resolve moduleId by code inline
INSERT INTO "RbacPermission" (id, "moduleId", action)
SELECT gen_random_uuid(), m.id, sub.action
FROM (VALUES
  ('tickets',    'close'),
  ('tickets',    'reopen'),
  ('billing',    'void'),
  ('billing',    'send_email'),
  ('scheduling', 'send_to_iclass'),
  ('scheduling', 'bulk_delete'),
  ('scheduling', 'move_stage'),
  ('scheduling', 'manage_checklist'),
  ('monitoring', 'acknowledge_alert'),
  ('network',    'manage_gpon'),
  ('network',    'manage_sites'),
  ('iclass',     'sync'),
  ('iclass',     'assign_to_project'),
  ('clients',    'manage_documents'),
  ('clients',    'manage_online_sessions'),
  ('admin',      'view_activity_log'),
  ('admin',      'manage_2fa'),
  ('rbac',       'manage_users'),
  ('rbac',       'manage_user_roles'),
  ('rbac',       'change_user_password'),
  ('rbac',       'manage_roles'),
  ('profile',    'change_own_password'),
  ('settings',   'manage_api_tokens'),
  ('settings',   'manage_backups')
) AS sub(module_code, action)
JOIN "RbacModule" m ON m.code = sub.module_code
ON CONFLICT ("moduleId", action) DO NOTHING;
```

Total sub-action rows: 24.

### Step 5 — Grant ALL new permissions to super_admin

```sql
INSERT INTO "RbacRolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
WHERE r.code = 'super_admin'
  AND NOT EXISTS (
    SELECT 1 FROM "RbacRolePermission" rp
    WHERE rp."roleId" = r.id AND rp."permissionId" = p.id
  );
```

This grants every permission (existing + new) to super_admin idempotently.
The `ON CONFLICT DO NOTHING` alternative requires a UNIQUE constraint on
`(roleId, permissionId)` — verify it exists from SDD #1.

---

## Domain entity updates

### `src/domain/entities/rbac.ts`

1. Replace `export type PermissionAction = 'read' | 'write' | 'delete' | 'manage'`
   with an open string type + whitelist const:

```ts
export const PERMISSION_ACTIONS = [
  // base
  'read', 'write', 'delete', 'manage',
  // tickets
  'close', 'reopen',
  // billing
  'void', 'send_email',
  // scheduling
  'send_to_iclass', 'bulk_delete', 'move_stage', 'manage_checklist',
  // monitoring
  'acknowledge_alert',
  // network
  'manage_gpon', 'manage_sites',
  // iclass
  'sync', 'assign_to_project',
  // clients
  'manage_documents', 'manage_online_sessions',
  // admin
  'view_activity_log', 'manage_2fa',
  // rbac
  'manage_users', 'manage_user_roles', 'change_user_password', 'manage_roles',
  // profile
  'change_own_password',
  // settings
  'manage_api_tokens', 'manage_backups',
] as const;

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];
```

2. Add new module codes to `RBAC_MODULES`:
```ts
'voices', 'partners', 'rbac', 'profile', 'notifications',
'dashboard', 'portal', 'search', 'support', 'sla', 'tariffs'
```

3. Update `RbacPermission.action` type from `PermissionAction` to `string`
   (since DB is now open varchar). Keep `PermissionAction` as the validated
   input type in use cases; the entity reflects DB reality.

   **Alternatively**: keep `action: PermissionAction` in the entity and
   validate at adapter boundary. Decision: keep `action: string` in entity,
   `PermissionAction` used only as input validation in use case layer.

### `prisma/schema.prisma`

Change `RbacPermission.action`:
```prisma
model RbacPermission {
  // ...
  action  String  // was: action RbacAction
  // ...
}
```

Remove enum declaration:
```prisma
// DELETE this:
enum RbacAction {
  read
  write
  delete
  manage
}
```

---

## Idempotency contract

The entire migration must be runnable twice without errors or duplicate rows:
- `ON CONFLICT (code) DO NOTHING` on modules
- `ON CONFLICT ("moduleId", action) DO NOTHING` on permissions
- NOT EXISTS guard on role-permission grants (or UNIQUE + ON CONFLICT)

---

## Requirements

### R1 — transaction boundary
All SQL steps run in a single transaction. If any step fails, no partial state
is committed.

### R2 — column type change is backwards-compatible
Existing rows with action values `read/write/delete/manage` remain valid after
varchar migration (string values are preserved by `USING action::text`).

### R3 — enum drop is safe
`DROP TYPE IF EXISTS "RbacAction"` is only safe if no other column in the schema
references it. Verify in `prisma/schema.prisma` before executing.

### R4 — super_admin retains full access
After migration, super_admin has grants for all permissions (existing 56 + new 68).

### R5 — migration is idempotent
Running the migration twice yields the same DB state.

---

## Scenarios (= test cases)

### S1 — module count after migration
```
Given: DB has 14 modules before migration
When:  migration runs
Then:  SELECT COUNT(*) FROM "RbacModule" = 25
```

### S2 — permission count after migration
```
Given: DB had 56 permissions (14 modules × 4 actions)
When:  migration runs
Then:  SELECT COUNT(*) FROM "RbacPermission"
       = 56 (existing)
       + 44 (11 new modules × 4 base actions)
       + 24 (sub-actions)
       = 124
```

### S3 — super_admin has all grants
```
Given: migration complete
When:  SELECT COUNT(*) FROM "RbacRolePermission" rp
       JOIN "RbacRole" r ON r.id = rp."roleId"
       WHERE r.code = 'super_admin'
Then:  count = 124 (one row per permission)
```

### S4 — existing action values preserved
```
Given: pre-migration row with action = 'read'
When:  migration runs
Then:  that row still has action = 'read' as VARCHAR
```

### S5 — re-run is no-op
```
Given: migration already applied
When:  migration runs a second time
Then:  no error, all counts unchanged
```

### S6 — RbacAction enum is gone
```
Given: migration complete
When:  SELECT typname FROM pg_type WHERE typname = 'RbacAction'
Then:  0 rows
```

---

## Implementation notes

- Migration file: `prisma/migrations/20260530000000_rbac_permission_catalog_extension/migration.sql`
- After writing the migration SQL, run `npx prisma migrate dev` with
  `--name rbac_permission_catalog_extension` (or add manually to migrations folder
  + mark as applied with `prisma migrate resolve`).
- No seed file changes needed — the migration itself is the seed (idempotent inserts).
- The `requirePermission` middleware uses `RbacModuleCode` type from entities —
  must be updated to include the 11 new module codes.
