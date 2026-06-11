/**
 * Migration SQL-text snapshot test for service_catalog (#43).
 * Verifies the migration creates ServiceCatalog + ContractService tables with the
 * correct structure, idempotent seed (ON CONFLICT (name) DO NOTHING with OTROS), and
 * correct CASCADE/RESTRICT FK semantics — all without an explicit BEGIN/COMMIT.
 *
 * Pattern mirrors migration.uisp_mirror.test.ts (static SQL assertions).
 *
 * NAME RULE: dir name '20260626000000_service_catalog' ends with '_service_catalog'.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('Migration: service_catalog', () => {
  let migrationSql: string;
  let nameMigrationSql: string;

  beforeAll(() => {
    const migrationsDir = path.resolve(__dirname, '../../../prisma/migrations');

    const catalogDirs = fs.readdirSync(migrationsDir).filter(d => d.endsWith('_service_catalog'));
    expect(catalogDirs.length).toBe(1);
    const migrationFile = path.join(migrationsDir, catalogDirs[0], 'migration.sql');
    expect(fs.existsSync(migrationFile)).toBe(true);
    migrationSql = fs.readFileSync(migrationFile, 'utf-8');

    const nameDirs = fs.readdirSync(migrationsDir).filter(d => d.endsWith('_contract_name'));
    expect(nameDirs.length).toBe(1);
    const nameFile = path.join(migrationsDir, nameDirs[0], 'migration.sql');
    expect(fs.existsSync(nameFile)).toBe(true);
    nameMigrationSql = fs.readFileSync(nameFile, 'utf-8');
  });

  // ── contract_name migration ────────────────────────────────────────────────
  it('contract_name adds nullable name column idempotently', () => {
    expect(nameMigrationSql).toMatch(/ALTER TABLE\s+"Contract"\s+ADD COLUMN IF NOT EXISTS\s+"name"\s+TEXT/i);
  });

  // ── No transaction wrapping ─────────────────────────────────────────────────
  it('does not wrap statements in an explicit BEGIN/COMMIT', () => {
    expect(migrationSql).not.toMatch(/\bBEGIN\b/i);
    expect(migrationSql).not.toMatch(/\bCOMMIT\b/i);
  });

  // ── ServiceCatalog table ────────────────────────────────────────────────────
  it('creates ServiceCatalog table with name UNIQUE', () => {
    expect(migrationSql).toMatch(/CREATE TABLE[^;]*"ServiceCatalog"/is);
    expect(migrationSql).toMatch(/CREATE UNIQUE INDEX[^;]*"ServiceCatalog"[^;]*"name"/i);
  });

  it('ServiceCatalog has active default true and sortOrder default 0', () => {
    const block = migrationSql.match(/CREATE TABLE[^;]*"ServiceCatalog"[^;]*;/is)?.[0] ?? '';
    expect(block).toMatch(/"active"\s+BOOLEAN\s+NOT NULL\s+DEFAULT\s+true/i);
    expect(block).toMatch(/"sortOrder"\s+INTEGER\s+NOT NULL\s+DEFAULT\s+0/i);
  });

  // ── Idempotent seed ─────────────────────────────────────────────────────────
  it('seeds 5 base services idempotently (ON CONFLICT (name) DO NOTHING)', () => {
    expect(migrationSql).toMatch(/INSERT INTO\s+"ServiceCatalog"/i);
    expect(migrationSql).toMatch(/ON CONFLICT\s*\(\s*name\s*\)\s*DO NOTHING/i);
  });

  it('seeds INTERNET, TV, VOZ, CAMARAS, OTROS', () => {
    expect(migrationSql).toMatch(/'INTERNET'/);
    expect(migrationSql).toMatch(/'TV'/);
    expect(migrationSql).toMatch(/'VOZ'/);
    expect(migrationSql).toMatch(/'CAMARAS'/);
    expect(migrationSql).toMatch(/'OTROS'/);
  });

  // ── ContractService pivot ───────────────────────────────────────────────────
  it('creates ContractService table', () => {
    expect(migrationSql).toMatch(/CREATE TABLE[^;]*"ContractService"/is);
  });

  it('ContractService has status default active and notes nullable', () => {
    const block = migrationSql.match(/CREATE TABLE[^;]*"ContractService"[^;]*;/is)?.[0] ?? '';
    expect(block).toMatch(/"status"\s+TEXT\s+NOT NULL\s+DEFAULT\s+'active'/i);
    expect(block).toMatch(/"notes"\s+TEXT/i);
  });

  it('ContractService has a UNIQUE (contractId, serviceCatalogId) index', () => {
    expect(migrationSql).toMatch(
      /CREATE UNIQUE INDEX[^;]*"ContractService"[^;]*"contractId"[^;]*"serviceCatalogId"/i,
    );
  });

  it('ContractService has an index on contractId', () => {
    expect(migrationSql).toMatch(/CREATE INDEX[^;]*"ContractService"[^;]*"contractId"/i);
  });

  it('contractId FK is ON DELETE CASCADE', () => {
    expect(migrationSql).toMatch(
      /FOREIGN KEY\s*\(\s*"contractId"\s*\)\s*REFERENCES\s*"Contract"[^;]*ON DELETE CASCADE/is,
    );
  });

  it('serviceCatalogId FK is ON DELETE RESTRICT', () => {
    expect(migrationSql).toMatch(
      /FOREIGN KEY\s*\(\s*"serviceCatalogId"\s*\)\s*REFERENCES\s*"ServiceCatalog"[^;]*ON DELETE RESTRICT/is,
    );
  });
});
