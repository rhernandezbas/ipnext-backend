/**
 * Migration SQL-text snapshot test for grant_clients_manage (#43, FF-1).
 *
 * WHY: The service-catalog ABM is gated by `clients.manage`. The RBAC foundation
 * migration (20260529000000_auth_rbac_foundation) grants ALL permissions ONLY to
 * super_admin — every other role starts with ZERO grants ("configured from UI").
 * `administrador` got `inventory.manage` / `scheduling.manage` later via DEDICATED
 * idempotent migrations (e.g. 20260604060000_add_inventory_manage_permission), which
 * `migrate deploy` runs in prod (seed.ts is dev-only). Without an equivalent grant
 * migration for `clients.manage`, a normal `administrador` would get 403 on the
 * catalog ABM.
 *
 * This migration replicates that exact pattern: grant `clients.manage` to the SAME
 * role(s) that already hold `inventory.manage` (administrador + super_admin),
 * idempotently (INSERT ... SELECT ... CROSS JOIN ... ON CONFLICT DO NOTHING).
 *
 * Pattern mirrors migration.service_catalog.test.ts (static SQL assertions).
 *
 * NAME RULE: dir name '20260627000000_grant_clients_manage' ends with '_grant_clients_manage'.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('Migration: grant_clients_manage', () => {
  let migrationSql: string;
  let dirName: string;

  beforeAll(() => {
    const migrationsDir = path.resolve(__dirname, '../../../prisma/migrations');
    const dirs = fs.readdirSync(migrationsDir).filter(d => d.endsWith('_grant_clients_manage'));
    expect(dirs.length).toBe(1);
    dirName = dirs[0];
    const migrationFile = path.join(migrationsDir, dirName, 'migration.sql');
    expect(fs.existsSync(migrationFile)).toBe(true);
    migrationSql = fs.readFileSync(migrationFile, 'utf-8');
  });

  it('migration dir name ends with _grant_clients_manage', () => {
    expect(dirName.endsWith('_grant_clients_manage')).toBe(true);
  });

  it('seeds the clients.manage permission idempotently', () => {
    expect(migrationSql).toMatch(/INSERT INTO\s+"RbacPermission"/i);
    expect(migrationSql).toMatch(/'manage'/);
    expect(migrationSql).toMatch(/"code"\s*=\s*'clients'/i);
    expect(migrationSql).toMatch(/ON CONFLICT\s*\(\s*"moduleId"\s*,\s*"action"\s*\)\s*DO NOTHING/i);
  });

  it('grants clients.manage to administrador (idempotent, mirrors inventory.manage)', () => {
    expect(migrationSql).toMatch(/INSERT INTO\s+"RbacRolePermission"/i);
    expect(migrationSql).toMatch(/'administrador'/);
    expect(migrationSql).toMatch(/ON CONFLICT\s*\(\s*"roleId"\s*,\s*"permissionId"\s*\)\s*DO NOTHING/i);
  });

  it('grants clients.manage to super_admin (idempotent)', () => {
    expect(migrationSql).toMatch(/'super_admin'/);
  });

  it('does not wrap statements in an explicit BEGIN/COMMIT', () => {
    expect(migrationSql).not.toMatch(/\bBEGIN\b/i);
    expect(migrationSql).not.toMatch(/\bCOMMIT\b/i);
  });
});
