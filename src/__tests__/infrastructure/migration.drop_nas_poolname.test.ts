/**
 * Migration SQL-text snapshot test for drop_nas_poolname (sqlippool-cleanup, REQ-DEL-2 / S2.2).
 * Verifica que la migración DROPEA la columna "NasServer"."poolName" (dormant: 0 NAS en modo pool
 * en prod, columna 100% NULL) — metadata-only, sin backfill, sin BEGIN/COMMIT.
 *
 * Mirrors migration.pppoe_nas_move_event.test.ts.
 *
 * NAME RULE: dir name must NOT contain substrings pinned by other snapshot tests.
 * 'drop_nas_poolname' es seguro (no colisiona con 'pppoe_ip_mode_and_nas_pool_name').
 */
import * as fs from 'fs';
import * as path from 'path';

describe('Migration: drop_nas_poolname', () => {
  let migrationSql: string;
  let dirName: string;

  beforeAll(() => {
    const migrationsDir = path.resolve(__dirname, '../../../prisma/migrations');
    const dirs = fs.readdirSync(migrationsDir).filter(d => d.endsWith('_drop_nas_poolname'));
    expect(dirs.length).toBe(1);
    dirName = dirs[0];
    const migrationFile = path.join(migrationsDir, dirs[0], 'migration.sql');
    expect(fs.existsSync(migrationFile)).toBe(true);
    migrationSql = fs.readFileSync(migrationFile, 'utf-8');
  });

  it('timestamp POSTERIOR a la última migración previa (20260826...)', () => {
    expect(dirName.slice(0, 14) > '20260826000000').toBe(true);
  });

  it('dropea la columna "NasServer"."poolName"', () => {
    expect(migrationSql).toMatch(/ALTER TABLE "NasServer" DROP COLUMN "poolName";/);
  });

  it('metadata-only: sin backfill (no INSERT/UPDATE) y solo toca NasServer', () => {
    expect(migrationSql).not.toMatch(/INSERT INTO/i);
    expect(migrationSql).not.toMatch(/UPDATE "/i);
    expect(migrationSql).not.toMatch(/ALTER TABLE "(?!NasServer)/);
    expect(migrationSql).not.toMatch(/DROP TABLE/i);
  });

  it('does NOT contain BEGIN or COMMIT (Prisma wraps in its own transaction)', () => {
    expect(migrationSql).not.toMatch(/^\s*BEGIN\s*;/im);
    expect(migrationSql).not.toMatch(/^\s*COMMIT\s*;/im);
  });
});
