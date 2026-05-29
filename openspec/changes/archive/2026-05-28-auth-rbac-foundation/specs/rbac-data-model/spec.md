# rbac-data-model Specification

## Purpose

Define the persisted schema for the RBAC foundation: modules, actions, permissions, roles, users, and their pivot tables. All tables are additive — zero changes to existing `Admin`, `ScheduledTask`, or other tables.

## Requirements

### Requirement: RbacModule table

The system MUST persist a `RbacModule` table with columns `id` (UUID PK), `code` (varchar UNIQUE NOT NULL), `label` (varchar NOT NULL), `createdAt` (timestamptz, default now). `code` is the stable FK target used in seed and middleware. (Field is `label`, not `name` — locked decision to avoid collision with `RbacUser.name`.)

#### Scenario: Module code is unique

- GIVEN the modules table already contains `{ code: "clients" }`
- WHEN an INSERT with `code: "clients"` is attempted
- THEN the DB raises a unique constraint violation

### Requirement: RbacPermission table

The system MUST persist a `RbacPermission` table with `id` (UUID PK), `moduleId` (UUID FK → RbacModule NOT NULL), `action` (Prisma enum `RbacAction { read write delete manage }` NOT NULL), and a UNIQUE constraint on `(moduleId, action)`. The action set is a closed enum at DB level — invalid values are rejected by PostgreSQL. (Locked decision: enum over varchar because actions are a fixed set hard-coded into middleware signatures; a table adds joins for zero flexibility.)

#### Scenario: Duplicate permission rejected

- GIVEN permission `(moduleId: X, action: read)` exists
- WHEN INSERT of `(moduleId: X, action: read)` is attempted
- THEN unique constraint violation is raised

#### Scenario: Invalid action rejected at DB level

- GIVEN the `RbacAction` enum has values `read | write | delete | manage`
- WHEN `action: "fly"` is inserted
- THEN PostgreSQL rejects it with an invalid enum value error

### Requirement: RbacRole table

The system MUST persist a `RbacRole` table with `id` (UUID PK), `code` (varchar UNIQUE NOT NULL), `label` (varchar NOT NULL), `isSystem` (boolean NOT NULL default false), `createdAt` (timestamptz), `updatedAt` (timestamptz). Note: field is `label` (not `name`), and there is no `description` column — omitted to keep schema minimal. System roles (`isSystem = true`) MUST NOT be deleted by CRUD operations (enforced in SDD #3).

#### Scenario: Role code uniqueness

- GIVEN role `{ code: "super_admin" }` exists
- WHEN INSERT with `code: "super_admin"` is attempted
- THEN unique constraint violation is raised

### Requirement: RbacUser table

The system MUST persist a `RbacUser` table with `id` (UUID PK), `name` (varchar NOT NULL), `email` (varchar UNIQUE NOT NULL), `login` (varchar UNIQUE NOT NULL), `passwordHash` (varchar NOT NULL), `status` (varchar NOT NULL default `"active"`), `createdAt` (timestamptz), `updatedAt` (timestamptz), `lastLoginAt` (timestamptz NULLABLE). `login` is globally unique. `passwordHash` is NOT NULL — no invitation-only flow.

#### Scenario: Login uniqueness enforced

- GIVEN user `{ login: "jdoe" }` exists
- WHEN INSERT with `login: "jdoe"` is attempted
- THEN unique constraint violation is raised

#### Scenario: Email uniqueness enforced

- GIVEN user `{ email: "j@example.com" }` exists
- WHEN INSERT with `email: "j@example.com"` is attempted
- THEN unique constraint violation is raised

### Requirement: RbacUserRole pivot table

The system MUST persist a `RbacUserRole` pivot with `userId` (UUID FK → RbacUser), `roleId` (UUID FK → RbacRole), `createdAt` (timestamptz). PK MUST be composite `(userId, roleId)`. Cascade DELETE on both FKs.

#### Scenario: Duplicate assignment rejected

- GIVEN `(userId: A, roleId: B)` already exists
- WHEN INSERT of `(userId: A, roleId: B)` is attempted
- THEN PK violation is raised

### Requirement: RbacRolePermission pivot table

The system MUST persist a `RbacRolePermission` pivot with `roleId` (UUID FK → RbacRole), `permissionId` (UUID FK → RbacPermission), `createdAt` (timestamptz). PK MUST be composite `(roleId, permissionId)`. Cascade DELETE on both FKs.

#### Scenario: Duplicate role-permission rejected

- GIVEN `(roleId: R, permissionId: P)` exists
- WHEN INSERT of `(roleId: R, permissionId: P)` is attempted
- THEN PK violation is raised

### Requirement: Indexes

The actual indexes built are:
- `RbacUserRole`: composite PK `(userId, roleId)` with `userId` as the leading key covers `listRolesForUser` queries; a secondary `@@index([roleId])` supports the inverse `listUsersForRole` direction.
- `RbacRolePermission`: composite PK `(roleId, permissionId)` with `roleId` as the leading key covers `listForRole` queries; a secondary `@@index([permissionId])` supports the inverse `listRolesForPermission` direction.

(A standalone `@@index([userId])` on `RbacUserRole` is NOT needed because the PK composite `(userId, roleId)` with userId as the leading column already serves as an efficient index for userId-leading lookups.)

#### Scenario: Permission resolution query is efficient

- GIVEN a user with 3 roles, each role with up to 56 permissions
- WHEN `requirePermission` resolves permissions for that user
- THEN the query uses index scans (not seq scans) on both pivot tables via the leading PK columns
