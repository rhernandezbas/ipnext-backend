/**
 * Migration data-transform + DDL test for inventory_foundation (Fixes #6/#7/#8/#9).
 *
 * NOTE: this repo has NO DB-free SQL harness (no pg-mem / sqlite runner) — the
 * established pattern (migration.network_node_task.test.ts) is a SQL-text snapshot
 * test. We mirror that: assert the migration.sql encodes the correct DDL + the
 * idempotent, case-insensitive, OTROS-guarded backfill. The transform LOGIC
 * (1 DEPOSITO + N CLIENTE + 1 asset per CII + 1 INSTALL per asset, re-run = no-op)
 * is verified structurally via the guards each step carries.
 *
 * GAP (honest): without a live/embedded Postgres we cannot EXECUTE the backfill
 * and count rows. The idempotency/correctness is guaranteed by the WHERE NOT EXISTS
 * / assetId IS NULL guards asserted below, not by running the SQL. A staging
 * dry-run is still recommended before applying on prod (see verify-report W-1).
 */
import * as fs from 'fs';
import * as path from 'path';

describe('Migration: inventory_foundation', () => {
  let sql: string;

  beforeAll(() => {
    const dir = path.resolve(__dirname, '../../../prisma/migrations/20260611000000_inventory_foundation');
    const file = path.join(dir, 'migration.sql');
    expect(fs.existsSync(file)).toBe(true);
    sql = fs.readFileSync(file, 'utf-8');
  });

  // ── Fix #6: qty is Decimal(12,4), not DOUBLE PRECISION ────────────────────
  describe('Fix #6 — Decimal qty (no Float/ledger drift)', () => {
    it('MaterialStock.qty is DECIMAL(12,4)', () => {
      expect(sql).toMatch(/"qty"\s+DECIMAL\(12\s*,\s*4\)/i);
    });

    it('does not declare any qty as DOUBLE PRECISION', () => {
      expect(sql).not.toMatch(/"qty"\s+DOUBLE PRECISION/i);
    });
  });

  // ── Fix #7: DB CHECK qty >= 0 on MaterialStock ────────────────────────────
  describe('Fix #7 — non-negative CHECK constraint', () => {
    it('adds MaterialStock_qty_nonneg CHECK (qty >= 0)', () => {
      expect(sql).toMatch(/CONSTRAINT\s+"MaterialStock_qty_nonneg"\s+CHECK\s*\(\s*"qty"\s*>=\s*0\s*\)/i);
    });
  });

  // ── Fix #8: case-insensitive deviceType join + OTROS fail-fast guard ───────
  describe('Fix #8 — case-insensitive join + OTROS guard', () => {
    it('joins DeviceTypeCatalog.name vs CII.type case-insensitively (upper=upper)', () => {
      expect(sql).toMatch(/upper\(\s*dtc\."name"\s*\)\s*=\s*upper\(\s*cii\."type"\s*\)/i);
    });

    it('does NOT use a bare case-sensitive name=type comparison in the asset backfill', () => {
      expect(sql).not.toMatch(/dtc\."name"\s*=\s*cii\."type"/i);
    });

    it('fails fast if the OTROS device type is absent before the backfill', () => {
      expect(sql).toMatch(/RAISE EXCEPTION 'OTROS device type required for inventory backfill'/i);
      expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM "DeviceTypeCatalog" WHERE name\s*=\s*'OTROS'\)/i);
    });
  });

  // ── Fix #9: backfill structure + idempotency guards ───────────────────────
  describe('Fix #9 — backfill transform structure (idempotent)', () => {
    it('seeds exactly one DEPOSITO singleton, guarded', () => {
      expect(sql).toMatch(/INSERT INTO "StockLocation"[\s\S]*'DEPOSITO'[\s\S]*WHERE NOT EXISTS \(SELECT 1 FROM "StockLocation" WHERE "code" = 'DEPOSITO'\)/i);
    });

    it('creates N CLIENTE locations (one per distinct contractId), guarded', () => {
      expect(sql).toMatch(/SELECT DISTINCT "contractId" FROM "ContractInstalledItem"/i);
      expect(sql).toMatch(/WHERE NOT EXISTS \([\s\S]*sl\."type" = 'CLIENTE'[\s\S]*\)/i);
    });

    it('creates one InventoryAsset per CII without an assetId (idempotent guard)', () => {
      expect(sql).toMatch(/INSERT INTO "InventoryAsset"[\s\S]*FROM "ContractInstalledItem" cii[\s\S]*WHERE cii\."assetId" IS NULL/i);
    });

    it('stamps CII.assetId only for rows still NULL (idempotent)', () => {
      expect(sql).toMatch(/UPDATE "ContractInstalledItem" cii[\s\S]*SET "assetId"[\s\S]*WHERE cii\."assetId" IS NULL/i);
    });

    it('creates one INSTALL movement per asset with no prior INSTALL (idempotent guard)', () => {
      expect(sql).toMatch(/INSERT INTO "InventoryMovement"[\s\S]*'INSTALL'[\s\S]*NOT EXISTS \([\s\S]*mv\."type" = 'INSTALL'[\s\S]*\)/i);
    });
  });
});
