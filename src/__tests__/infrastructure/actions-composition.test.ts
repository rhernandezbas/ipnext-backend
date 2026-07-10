/**
 * actions-composition.test.ts — assertion estática sobre app.ts (patrón
 * pppoe-composition / gigared-composition). Anti-"feature muerta": pinea el
 * wiring del router /api/actions + RBAC + la migración de permisos.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Actions composition root (actions-worklist W2)', () => {
  let appSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8');
  });

  it('(a) createActionsRouter está importado', () => {
    expect(appSrc).toMatch(/import.*createActionsRouter.*from.*actions\.routes/);
  });

  it("(b) router montado en '/api/actions'", () => {
    expect(appSrc).toMatch(/app\.use\(\s*['"]\/api\/actions['"]\s*,\s*createActionsRouter\(/);
  });

  it('(c) guards RBAC read+manage y auth STATEFUL dentro de la llamada (ventana acotada al call)', () => {
    const idx = appSrc.indexOf("app.use('/api/actions'");
    expect(idx).toBeGreaterThan(-1);
    const end = appSrc.indexOf('));', idx);
    expect(end).toBeGreaterThan(idx);
    const window = appSrc.slice(idx, end + '));'.length);
    expect(window).toMatch(/requirePerm\('actions',\s*'read'\)/);
    expect(window).toMatch(/requirePerm\('actions',\s*'manage'\)/);
    expect(window).toMatch(/createAuthMiddleware\(authAdapter,\s*sessionRepo\)/);
  });

  it('(d) adapters Prisma de la W2 instanciados (caso + pairing + retiro)', () => {
    expect(appSrc).toMatch(/new PrismaOwnershipCaseRepository\(\)/);
    expect(appSrc).toMatch(/new PrismaContractPairingReader\(\)/);
    expect(appSrc).toMatch(/new PrismaRetirementOrderReader\(\)/);
  });

  it('(e) los tres use cases wired', () => {
    expect(appSrc).toMatch(/new ListOwnershipCases\(/);
    expect(appSrc).toMatch(/new UpdateOwnershipCase\(/);
    expect(appSrc).toMatch(/new ListRecentBajas\(/);
  });

  it('(f) ListOwnershipCases recibe userLookupForScheduling (nombres del reviewer manual)', () => {
    expect(appSrc).toMatch(/new ListOwnershipCases\([\s\S]*?userLookupForScheduling/);
  });
});

describe("RBAC módulo 'actions' (RBAC-1)", () => {
  it("rbac.ts declara 'actions' en RBAC_MODULES", () => {
    const rbacSrc = readFileSync(
      join(__dirname, '..', '..', 'domain', 'entities', 'rbac.ts'),
      'utf8',
    );
    expect(rbacSrc).toMatch(/'actions',/);
  });
});

describe('Migración 20260903000000_actions_permissions (RBAC-1: seed idempotente)', () => {
  let sql: string;

  beforeAll(() => {
    sql = readFileSync(
      join(__dirname, '..', '..', '..', 'prisma', 'migrations', '20260903000000_actions_permissions', 'migration.sql'),
      'utf8',
    );
  });

  it("seedea el módulo 'actions'", () => {
    expect(sql).toMatch(/'actions'/);
  });

  it('seedea permisos read y manage del módulo', () => {
    expect(sql).toMatch(/'read'/);
    expect(sql).toMatch(/'manage'/);
  });

  it('grants a super_admin Y administrador', () => {
    expect(sql).toMatch(/'super_admin'/);
    expect(sql).toMatch(/'administrador'/);
  });

  it('TODOS los INSERT son idempotentes: 7 INSERT (módulo + 2 permisos + 4 grants), cada uno con ON CONFLICT DO NOTHING', () => {
    const inserts = sql.match(/INSERT INTO/g) ?? [];
    const conflicts = sql.match(/ON CONFLICT[^;]*DO NOTHING/g) ?? [];
    expect(inserts).toHaveLength(7);
    expect(conflicts).toHaveLength(inserts.length);
  });

  it('sin BEGIN/COMMIT explícito (Prisma envuelve cada migración en su propia transacción)', () => {
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/m);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/m);
  });
});

describe('errorHandler — codes nuevos de actions mapeados (ROB-1)', () => {
  let handlerSrc: string;

  beforeAll(() => {
    handlerSrc = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'http', 'middleware', 'errorHandler.ts'),
      'utf8',
    );
  });

  it('OWNERSHIP_CASE_NOT_FOUND → 404', () => {
    expect(handlerSrc).toMatch(/OWNERSHIP_CASE_NOT_FOUND:\s*404/);
  });

  it('INVALID_CANDIDATE_PICK → 422', () => {
    expect(handlerSrc).toMatch(/INVALID_CANDIDATE_PICK:\s*422/);
  });

  it('INVALID_CASE_TRANSITION → 422', () => {
    expect(handlerSrc).toMatch(/INVALID_CASE_TRANSITION:\s*422/);
  });

  it('INVALID_TARGET_ASSIGNMENT → 422 (H1b set-target)', () => {
    expect(handlerSrc).toMatch(/INVALID_TARGET_ASSIGNMENT:\s*422/);
  });

  it('DISMISS_REASON_REQUIRED → 400', () => {
    expect(handlerSrc).toMatch(/DISMISS_REASON_REQUIRED:\s*400/);
  });
});

// B2/W6 — anti-"detector muerto": pinea el wiring del detector en el bootstrap
// del scheduler (espejo del patrón gr-contract-delta-composition.test.ts).
describe('Detector composition root (bootstrapGestionRealSync)', () => {
  let bootstrapSrc: string;

  beforeAll(() => {
    bootstrapSrc = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'scheduling', 'bootstrapGestionRealSync.ts'),
      'utf8',
    );
  });

  it('importa DetectOwnershipTransferCases', () => {
    expect(bootstrapSrc).toMatch(/import.*DetectOwnershipTransferCases.*from/);
  });

  it('instancia DetectOwnershipTransferCases (repo + pairing reader Prisma)', () => {
    expect(bootstrapSrc).toMatch(/new DetectOwnershipTransferCases\(/);
  });

  it('pasa detectOwnershipCases al constructor del scheduler (no solo lo construye)', () => {
    const schedulerIdx = bootstrapSrc.indexOf('new GestionRealSyncScheduler(');
    expect(schedulerIdx).toBeGreaterThan(-1);
    const constructorCall = bootstrapSrc.slice(schedulerIdx, schedulerIdx + 500);
    expect(constructorCall).toMatch(/detectOwnershipCases/);
  });
});
