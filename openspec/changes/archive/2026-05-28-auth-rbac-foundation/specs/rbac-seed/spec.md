# rbac-seed Specification

## Purpose

Define the idempotent catalog seed that runs inside the Prisma migration DDL. All INSERTs use `ON CONFLICT DO NOTHING`. No data lives in `seed.ts`.

## Requirements

### Requirement: Module catalog seed

The migration MUST seed exactly 14 modules using `INSERT INTO "RbacModule" (id, code, name) VALUES ... ON CONFLICT (code) DO NOTHING`.

Modules (code → display name):

| code | name |
|------|------|
| clients | Clientes |
| billing | Facturación |
| scheduling | Agendamiento |
| network | Red |
| admin | Administración |
| monitoring | Monitoreo |
| iclass | IClass |
| gestionReal | Gestión Real |
| reports | Reportes |
| tickets | Tickets |
| settings | Configuración |
| crm | CRM |
| inventory | Inventario |
| vehicles | Vehículos |

#### Scenario: Re-running migration does not duplicate modules

- GIVEN migration was already applied and 14 modules exist
- WHEN the migration SQL is executed again (or on a second deploy)
- THEN module count remains 14 (no duplicates, no error)

### Requirement: Permission catalog seed

The migration MUST seed exactly 56 permissions (14 modules × 4 actions: `read`, `write`, `delete`, `manage`) using `ON CONFLICT (moduleId, action) DO NOTHING`.

#### Scenario: All 56 permissions exist after migration

- GIVEN a fresh DB with migration applied
- WHEN `SELECT count(*) FROM "RbacPermission"` is executed
- THEN result is 56

### Requirement: System roles seed

The migration MUST seed exactly 6 system roles (`isSystem = true`) using `ON CONFLICT (code) DO NOTHING`:

| code | name | Semantics (business meaning — do NOT alter) |
|------|------|---------------------------------------------|
| super_admin | Super Administrador | Acceso total. Bypass en middleware. |
| administrador | Administrador | Dueño/jefe del negocio (owner). NO es manager técnico. |
| administracion | Administración | Contabilidad (billing, recibos, facturación). |
| ventas | Ventas | Equipo comercial. |
| noc | NOC | Network Operations Center (red, monitoreo, tickets de red). |
| tecnico | Técnico | Técnicos de campo. |

#### Scenario: System roles are idempotent

- GIVEN roles already exist
- WHEN migration re-runs
- THEN 6 roles remain, `isSystem = true` for all 6

### Requirement: Minimal RolePermission seed

The migration MUST seed `RbacRolePermission` ONLY for `super_admin` (all 56 permissions). The 5 non-`super_admin` roles MUST be seeded EMPTY — zero rows in `RbacRolePermission`.

Rationale: the permission matrix is managed dynamically from the UI (SDD #3 — Roles y Permisos). Arrancar con permisos vacíos es seguro: nadie tiene acceso que no fue concedido explícitamente. El user con `super_admin` configura el resto desde la UI.

Insert pattern:

```sql
INSERT INTO "RbacRolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "RbacRole" r CROSS JOIN "RbacPermission" p
WHERE r.code = 'super_admin'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
```

#### Scenario: super_admin has all permissions

- GIVEN migration applied on fresh DB
- WHEN querying `RbacRolePermission` joined to `RbacRole` where `code = "super_admin"`
- THEN row count equals 56

#### Scenario: Non-super_admin roles start empty

- GIVEN migration applied on fresh DB
- WHEN querying `RbacRolePermission` joined to `RbacRole` where `code != "super_admin"`
- THEN row count equals 0

#### Scenario: Re-seeding super_admin permissions is idempotent

- GIVEN migration applied
- WHEN migration SQL re-executes
- THEN `RbacRolePermission` count for super_admin remains 56 (no duplicates)

#### Scenario: New permission added later is NOT auto-granted to super_admin by old migration

- GIVEN migration applied
- WHEN a future migration inserts a new permission row
- THEN super_admin does NOT receive it via this migration (future migration MUST include its own super_admin grant)

NOTE: The middleware short-circuits for `super_admin` (`requirePermission` returns granted without DB lookup). This ensures super_admin can never be locked out even if `RbacRolePermission` rows are accidentally deleted from the UI.
