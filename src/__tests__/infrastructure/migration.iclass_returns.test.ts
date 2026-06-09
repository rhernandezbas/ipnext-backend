/**
 * Migration SQL-text snapshot test (EPIC #38 W4, Wave 4 review follow-up):
 * Verifies the 20260612000000_iclass_returns migration exists and contains the
 * load-bearing DDL: the ReturnSuggestion table + its @@unique([serviceOrderId, serialNumber]),
 * the InventoryMovement.sourceRef PARTIAL UNIQUE (WHERE sourceRef IS NOT NULL), the
 * ReturnSuggestion.sourceRef column (Fix #5), and the removal-code seed.
 *
 * Mirrors migration.network_node_task.test.ts — guards against an accidental
 * `prisma migrate` rewrite that would index the NULL legacy rows (full unique → collision).
 */
import * as fs from 'fs';
import * as path from 'path';

describe('Migration: iclass_returns', () => {
  let migrationSql: string;

  beforeAll(() => {
    const migrationsDir = path.resolve(__dirname, '../../../prisma/migrations');
    const dirs = fs.readdirSync(migrationsDir).filter(d => d.includes('iclass_returns'));
    expect(dirs.length).toBe(1);
    const migrationFile = path.join(migrationsDir, dirs[0], 'migration.sql');
    expect(fs.existsSync(migrationFile)).toBe(true);
    migrationSql = fs.readFileSync(migrationFile, 'utf-8');
  });

  it('creates the ReturnSuggestion table', () => {
    expect(migrationSql).toMatch(/CREATE TABLE IF NOT EXISTS "ReturnSuggestion"/i);
  });

  it('adds the @@unique([serviceOrderId, serialNumber]) dedup index', () => {
    expect(migrationSql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "ReturnSuggestion_serviceOrderId_serialNumber_key"[\s\S]*?"serviceOrderId",\s*"serialNumber"/i,
    );
  });

  it('adds InventoryMovement.sourceRef column', () => {
    expect(migrationSql).toMatch(/ALTER TABLE "InventoryMovement"[\s\S]*?ADD COLUMN IF NOT EXISTS "sourceRef"/i);
  });

  it('creates the sourceRef PARTIAL UNIQUE (WHERE sourceRef IS NOT NULL) — NOT a full @@unique', () => {
    expect(migrationSql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "InventoryMovement_sourceRef_key"[\s\S]*?ON "InventoryMovement"\("sourceRef"\)[\s\S]*?WHERE "sourceRef" IS NOT NULL/i,
    );
  });

  it('adds the ReturnSuggestion.sourceRef column (Fix #5) idempotently', () => {
    expect(migrationSql).toMatch(
      /ALTER TABLE "ReturnSuggestion" ADD COLUMN IF NOT EXISTS "sourceRef" TEXT/i,
    );
  });

  it('adds the L1 idempotency flag IClassServiceOrder.inventoryReturnsProcessed', () => {
    expect(migrationSql).toMatch(
      /ALTER TABLE "IClassServiceOrder"[\s\S]*?ADD COLUMN IF NOT EXISTS "inventoryReturnsProcessed"/i,
    );
  });

  it('seeds isRemovalCode=true for the two confirmed removal codes', () => {
    expect(migrationSql).toMatch(/SET "isRemovalCode" = true/i);
    expect(migrationSql).toMatch(/Retiro completo Servicio Fibra/);
    expect(migrationSql).toMatch(/Retiro completo Servicio Wireless/);
  });
});
