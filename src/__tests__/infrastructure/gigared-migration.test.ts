/**
 * #47 — static snapshot guard for the gigared_tv migration.
 * Booting a real DB is out of scope here; we assert the SQL contains the additive,
 * idempotent pieces required by the spec (no BEGIN/COMMIT; table + RBAC + grants + flag).
 *
 * #50 — static snapshot guard for the tv_granular_permissions migration.
 * Asserts: seeds link/register/packs/ott/cancel for module tv; grants to super_admin +
 * administrador; every INSERT is idempotent (ON CONFLICT DO NOTHING); no BEGIN/COMMIT.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('20260630000000_gigared_tv migration (#47)', () => {
  let sql: string;

  beforeAll(() => {
    sql = readFileSync(
      join(__dirname, '..', '..', '..', 'prisma', 'migrations', '20260630000000_gigared_tv', 'migration.sql'),
      'utf8',
    );
  });

  it('is additive — no BEGIN;/COMMIT; statements (Prisma wraps it)', () => {
    // Strip comment lines so a mention in a `-- … no BEGIN/COMMIT …` note never trips the guard.
    const statements = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(statements).not.toMatch(/\bBEGIN\s*;/i);
    expect(statements).not.toMatch(/\bCOMMIT\s*;/i);
  });

  it('creates the GigaredConfig table with singleton id + apiKey/baseUrl defaults', () => {
    expect(sql).toMatch(/CREATE TABLE "GigaredConfig"/);
    expect(sql).toMatch(/"apiKey"\s+TEXT\s+NOT NULL\s+DEFAULT ''/);
    expect(sql).toMatch(/partners\.gigaredsa\.com\.ar\/api\/v1/);
  });

  it("seeds the 'tv' RBAC module + read/write/manage permissions", () => {
    expect(sql).toMatch(/INSERT INTO "RbacModule"[\s\S]*'tv'[\s\S]*'TV \/ Gigared'/);
    expect(sql).toMatch(/'read'/);
    expect(sql).toMatch(/'write'/);
    expect(sql).toMatch(/'manage'/);
  });

  it('grants tv perms to BOTH super_admin and administrador', () => {
    expect(sql).toMatch(/'super_admin'/);
    expect(sql).toMatch(/'administrador'/);
  });

  it("seeds the 'gigared-integration' feature flag as OFF", () => {
    expect(sql).toMatch(/INSERT INTO "FeatureFlag"[\s\S]*'gigared-integration'[\s\S]*false/);
  });

  it('every INSERT is idempotent (ON CONFLICT DO NOTHING)', () => {
    const inserts = sql.match(/INSERT INTO/g) ?? [];
    const conflicts = sql.match(/ON CONFLICT/g) ?? [];
    expect(inserts.length).toBeGreaterThan(0);
    expect(conflicts.length).toBeGreaterThanOrEqual(inserts.length);
  });
});

describe('20260705000000_tv_granular_permissions migration (#50)', () => {
  let sql: string;

  beforeAll(() => {
    sql = readFileSync(
      join(
        __dirname, '..', '..', '..', 'prisma', 'migrations',
        '20260705000000_tv_granular_permissions', 'migration.sql',
      ),
      'utf8',
    );
  });

  it('is additive — no BEGIN;/COMMIT; statements (Prisma wraps it)', () => {
    const statements = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(statements).not.toMatch(/\bBEGIN\s*;/i);
    expect(statements).not.toMatch(/\bCOMMIT\s*;/i);
  });

  it("seeds the 5 granular tv permissions: link, register, packs, ott, cancel", () => {
    expect(sql).toMatch(/'link'/);
    expect(sql).toMatch(/'register'/);
    expect(sql).toMatch(/'packs'/);
    expect(sql).toMatch(/'ott'/);
    expect(sql).toMatch(/'cancel'/);
    // All 5 are seeded in a single INSERT referencing the tv module
    expect(sql).toMatch(/WHERE m\."code" = 'tv'/);
  });

  it('grants the 5 granular tv permissions to super_admin AND administrador', () => {
    expect(sql).toMatch(/'super_admin'/);
    expect(sql).toMatch(/'administrador'/);
    // The grant INSERT must scope to the tv module and the 5 actions
    expect(sql).toMatch(/m\."code" = 'tv'/);
    expect(sql).toMatch(/p\."action" IN \('link', 'register', 'packs', 'ott', 'cancel'\)/);
  });

  it('every INSERT is idempotent (ON CONFLICT … DO NOTHING)', () => {
    const inserts = sql.match(/INSERT INTO/g) ?? [];
    // Migration uses ON CONFLICT (...) DO NOTHING — match the DO NOTHING part regardless of column list
    const conflicts = sql.match(/ON CONFLICT[\s\S]*?DO NOTHING/g) ?? [];
    expect(inserts.length).toBeGreaterThan(0);
    expect(conflicts.length).toBeGreaterThanOrEqual(inserts.length);
  });

  it('does NOT contain a generic tv.write permission seed (only granular actions)', () => {
    // Verify that this migration does NOT seed the old generic write action for tv
    // (that belongs to the #47 migration, not this one)
    const nonCommentLines = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    // 'write' should not appear as a seeded action in this migration
    expect(nonCommentLines).not.toMatch(/\('write'\)/);
  });
});
