/**
 * Migration SQL-text snapshot test for portal_manage_permission (customer-portal-api,
 * Fase 3, task 3.3). Mirrors `migration.grant_clients_manage.test.ts` (same pattern:
 * grant an EXISTING permission to the admin roles via a dedicated idempotent
 * migration, since seed.ts is dev-only and prod runs `migrate deploy`).
 *
 * IMPORTANT discovery (verified against the actual migrations, not assumed):
 * the `portal` RBAC module AND its base `manage` action already exist in the DB —
 * seeded generically by 20260529200000_rbac_permission_catalog_extension's
 * 4-base-actions × 11-new-modules cross join (module 'portal' is module #7 of
 * that batch). `RBAC_MODULES` in src/domain/entities/rbac.ts already lists
 * 'portal' too. So there is NOTHING to add to the TS catalog or to RbacModule/
 * RbacPermission — 'portal.manage' the ROW already exists (super_admin already
 * holds it via that same migration's step 6, "grant ALL to super_admin"). The
 * ONLY gap is that no role other than super_admin has ever been granted it —
 * this migration closes that gap for 'administrador', mirroring the
 * inventory.manage / clients.manage precedent EXACTLY.
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * M3 (fix wave) — regla del repo "tests sobre texto filtran comentarios": los
 * asserts corren sobre el SQL EFECTIVO (sin `--` comments). Antes un comentario
 * que dijera "grant portal.manage to administrador" hacia pasar la suite aunque
 * el INSERT real no existiera.
 */
function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

describe('Migration: portal_manage_permission', () => {
  let migrationSql: string;
  let dirName: string;

  beforeAll(() => {
    const migrationsDir = path.resolve(__dirname, '../../../../prisma/migrations');
    const dirs = fs.readdirSync(migrationsDir).filter((d) => d.endsWith('_portal_manage_permission'));
    expect(dirs.length).toBe(1);
    dirName = dirs[0];
    const migrationFile = path.join(migrationsDir, dirName, 'migration.sql');
    expect(fs.existsSync(migrationFile)).toBe(true);
    // M3 — SQL EFECTIVO: comentarios fuera ANTES de cualquier match.
    migrationSql = stripSqlComments(fs.readFileSync(migrationFile, 'utf-8'));
  });

  it('migration dir name ends with _portal_manage_permission', () => {
    expect(dirName.endsWith('_portal_manage_permission')).toBe(true);
  });

  it('is timestamped AFTER the Fase 1 portal_account_session migration (20261028000100)', () => {
    const timestamp = dirName.split('_')[0];
    expect(timestamp >= '20261028000200').toBe(true);
  });

  it('seeds the portal.manage permission idempotently (safety net — likely already seeded)', () => {
    expect(migrationSql).toMatch(/INSERT INTO\s+"RbacPermission"/i);
    expect(migrationSql).toMatch(/'manage'/);
    expect(migrationSql).toMatch(/"code"\s*=\s*'portal'/i);
    expect(migrationSql).toMatch(/ON CONFLICT\s*\(\s*"moduleId"\s*,\s*"action"\s*\)\s*DO NOTHING/i);
  });

  it('grants portal.manage to administrador (idempotent, mirrors inventory.manage/clients.manage)', () => {
    // M3 — el statement COMPLETO del grant en el SQL efectivo: el INSERT a
    // RbacRolePermission cuyo WHERE filtra rol 'administrador' + modulo
    // 'portal' + accion 'manage', cerrado con el ON CONFLICT idempotente.
    // Un comentario no puede satisfacer este match (los comments ya se
    // strippearon) ni un INSERT a otra tabla / de otro rol.
    expect(migrationSql).toMatch(
      /INSERT INTO\s+"RbacRolePermission"[\s\S]*?WHERE\s+r\."code"\s*=\s*'administrador'[\s\S]*?m\."code"\s*=\s*'portal'[\s\S]*?p\."action"\s*=\s*'manage'[\s\S]*?ON CONFLICT\s*\(\s*"roleId"\s*,\s*"permissionId"\s*\)\s*DO NOTHING/i,
    );
  });

  it('grants portal.manage to super_admin (idempotent safety net)', () => {
    expect(migrationSql).toMatch(
      /INSERT INTO\s+"RbacRolePermission"[\s\S]*?WHERE\s+r\."code"\s*=\s*'super_admin'[\s\S]*?m\."code"\s*=\s*'portal'[\s\S]*?p\."action"\s*=\s*'manage'[\s\S]*?ON CONFLICT\s*\(\s*"roleId"\s*,\s*"permissionId"\s*\)\s*DO NOTHING/i,
    );
  });

  it('does not wrap statements in an explicit BEGIN/COMMIT (Prisma wraps each migration)', () => {
    expect(migrationSql).not.toMatch(/\bBEGIN\b/i);
    expect(migrationSql).not.toMatch(/\bCOMMIT\b/i);
  });
});
