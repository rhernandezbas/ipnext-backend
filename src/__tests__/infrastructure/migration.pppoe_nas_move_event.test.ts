/**
 * Migration SQL-text snapshot test for pppoe_nas_move_event (pppoe-move-nas W1, design D6 punto 2).
 * Verifica que la migración ADITIVA crea la tabla "PppoeNasMoveEvent" con las columnas del design
 * (username/trigger/outcome NOT NULL, resto nullable) + índices de consulta del listado.
 *
 * Mirrors migration.project_network_flag.test.ts.
 *
 * NAME RULE: dir name must NOT contain substrings pinned by other snapshot tests.
 * 'pppoe_nas_move_event' is safe (no colisiona con 'pppoe_ip_mode_and_nas_pool_name').
 */
import * as fs from 'fs';
import * as path from 'path';

describe('Migration: pppoe_nas_move_event', () => {
  let migrationSql: string;
  let dirName: string;

  beforeAll(() => {
    const migrationsDir = path.resolve(__dirname, '../../../prisma/migrations');
    const dirs = fs.readdirSync(migrationsDir).filter(d => d.endsWith('_pppoe_nas_move_event'));
    expect(dirs.length).toBe(1);
    dirName = dirs[0];
    const migrationFile = path.join(migrationsDir, dirs[0], 'migration.sql');
    expect(fs.existsSync(migrationFile)).toBe(true);
    migrationSql = fs.readFileSync(migrationFile, 'utf-8');
  });

  it('timestamp POSTERIOR a la última migración previa (20260823...)', () => {
    expect(dirName.slice(0, 14) > '20260823000000').toBe(true);
  });

  it('crea la tabla "PppoeNasMoveEvent"', () => {
    expect(migrationSql).toMatch(/CREATE TABLE "PppoeNasMoveEvent"/);
  });

  it('columnas obligatorias: username, trigger, outcome NOT NULL', () => {
    expect(migrationSql).toMatch(/"username" TEXT NOT NULL/);
    expect(migrationSql).toMatch(/"trigger" TEXT NOT NULL/);
    expect(migrationSql).toMatch(/"outcome" TEXT NOT NULL/);
  });

  it('columnas opcionales nullable: pppoeServiceId, fromNasId, toNasId, fromIp, toIp, reason, actorName', () => {
    for (const col of ['pppoeServiceId', 'fromNasId', 'toNasId', 'fromIp', 'toIp', 'reason', 'actorName']) {
      expect(migrationSql).toMatch(new RegExp(`"${col}" TEXT(,|\\s)`));
      expect(migrationSql).not.toMatch(new RegExp(`"${col}" TEXT NOT NULL`));
    }
  });

  it('createdAt con DEFAULT CURRENT_TIMESTAMP', () => {
    expect(migrationSql).toMatch(/"createdAt" TIMESTAMP\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP/);
  });

  it('índices para el listado: createdAt, username, outcome+createdAt, trigger+createdAt', () => {
    expect(migrationSql).toMatch(/CREATE INDEX "PppoeNasMoveEvent_createdAt_idx"/);
    expect(migrationSql).toMatch(/CREATE INDEX "PppoeNasMoveEvent_username_idx"/);
    expect(migrationSql).toMatch(/CREATE INDEX "PppoeNasMoveEvent_outcome_createdAt_idx"/);
    expect(migrationSql).toMatch(/CREATE INDEX "PppoeNasMoveEvent_trigger_createdAt_idx"/);
  });

  it('es ADITIVA: no dropea ni altera tablas existentes', () => {
    expect(migrationSql).not.toMatch(/DROP TABLE/i);
    expect(migrationSql).not.toMatch(/DROP COLUMN/i);
    expect(migrationSql).not.toMatch(/ALTER TABLE "(?!PppoeNasMoveEvent)/);
  });

  it('does NOT contain BEGIN or COMMIT (Prisma wraps in its own transaction)', () => {
    expect(migrationSql).not.toMatch(/^\s*BEGIN\s*;/im);
    expect(migrationSql).not.toMatch(/^\s*COMMIT\s*;/im);
  });
});
