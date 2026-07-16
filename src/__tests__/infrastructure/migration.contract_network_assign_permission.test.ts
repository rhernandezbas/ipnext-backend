/**
 * Migration SQL-text snapshot test for contract_network_assign_permission (MIG-2).
 * Verifies the seed of the (contracts, assign) RBAC permission + grants, idempotent.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('Migration: contract_network_assign_permission', () => {
  let migrationSql: string;

  beforeAll(() => {
    const migrationsDir = path.resolve(__dirname, '../../../prisma/migrations');
    const dirs = fs.readdirSync(migrationsDir).filter(d => d.endsWith('_contract_network_assign_permission'));
    expect(dirs.length).toBe(1);
    const migrationFile = path.join(migrationsDir, dirs[0], 'migration.sql');
    expect(fs.existsSync(migrationFile)).toBe(true);
    migrationSql = fs.readFileSync(migrationFile, 'utf-8');
  });

  it('inserts the (contracts, assign) RbacPermission', () => {
    expect(migrationSql).toMatch(/INSERT INTO "RbacPermission"/);
    expect(migrationSql).toMatch(/'assign'/);
    expect(migrationSql).toMatch(/WHERE m\."code" = 'contracts'/);
  });

  it('grants the permission to super_admin', () => {
    expect(migrationSql).toMatch(/WHERE r\."code" = 'super_admin'[\s\S]*?AND p\."action" = 'assign'/);
  });

  it('grants the permission to administrador', () => {
    expect(migrationSql).toMatch(/WHERE r\."code" = 'administrador'[\s\S]*?AND p\."action" = 'assign'/);
  });

  it('every INSERT is idempotent (ON CONFLICT DO NOTHING)', () => {
    const insertCount = (migrationSql.match(/INSERT INTO/g) ?? []).length;
    const conflictCount = (migrationSql.match(/ON CONFLICT .* DO NOTHING/g) ?? []).length;
    expect(insertCount).toBeGreaterThan(0);
    expect(conflictCount).toBe(insertCount);
  });

  it('has NO destructive statements (DROP/DELETE)', () => {
    expect(migrationSql).not.toMatch(/DROP/i);
    expect(migrationSql).not.toMatch(/DELETE FROM/i);
  });
});
