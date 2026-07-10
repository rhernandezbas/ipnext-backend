/**
 * pppoe-composition.test.ts — assertion estática sobre app.ts.
 *
 * Propósito: pinear el wiring PPPoE en createApp() para que cualquier
 * reorganización de app.ts que saque el router o rompa la DI sea detectada
 * inmediatamente (sin levantar la DB real). Anti-"feature muerta".
 *
 * Assertions:
 *   (a) createPppoeRouter está importado en app.ts
 *   (b) createPppoeRouter es llamado con requirePerm (RBAC wiring presente)
 *   (c) el router se monta en '/api' (para que /api/contracts y /api/pppoe funcionen)
 *   (d) PrismaPppoeServiceRepository está instanciado en el bloque PPPoE
 *   (e) ListPppoeByContract, CreatePppoeService, UpdatePppoeService,
 *       MovePppoeServiceToRouter, DeactivatePppoeService están wired
 *   (f) RouterOsGateway está instanciado en el bloque PPPoE
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('PPPoE composition root (#pppoe-service Fase B)', () => {
  let appSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8');
  });

  it('(a) createPppoeRouter está importado', () => {
    expect(appSrc).toMatch(/import.*createPppoeRouter.*from.*pppoe\.routes/);
  });

  it('(b) createPppoeRouter es llamado con requirePerm (RBAC guard presente)', () => {
    const idx = appSrc.indexOf('createPppoeRouter(');
    expect(idx).toBeGreaterThan(-1);
    const window = appSrc.slice(idx, idx + 600);
    expect(window).toMatch(/requirePerm/);
  });

  it("(c) router PPPoE montado en '/api'", () => {
    expect(appSrc).toMatch(/app\.use\(\s*['"]\/api['"]\s*,\s*createPppoeRouter/);
  });

  it('(d) PrismaPppoeServiceRepository está instanciado', () => {
    expect(appSrc).toMatch(/new PrismaPppoeServiceRepository\(\)/);
  });

  it('(e) RouterOsGateway está instanciado', () => {
    expect(appSrc).toMatch(/new RouterOsGateway\(\)/);
  });

  it('(e) ListPppoeByContract está wired', () => {
    expect(appSrc).toMatch(/new ListPppoeByContract\(/);
  });

  it('(e) CreatePppoeService está wired', () => {
    expect(appSrc).toMatch(/new CreatePppoeService\(/);
  });

  it('(e) UpdatePppoeService está wired', () => {
    expect(appSrc).toMatch(/new UpdatePppoeService\(/);
  });

  it('(e) MovePppoeServiceToRouter está wired', () => {
    expect(appSrc).toMatch(/new MovePppoeServiceToRouter\(/);
  });

  it('(e) DeactivatePppoeService está wired', () => {
    expect(appSrc).toMatch(/new DeactivatePppoeService\(/);
  });

  // ── Fase C — enforcement (cortes) ──────────────────────────────────────────
  it('(f) RouterOsEnforcementAdapter está wired con el reducedProfile de config', () => {
    expect(appSrc).toMatch(/new RouterOsEnforcementAdapter\([^)]*config\.router\.reducedProfile/s);
  });

  it('(f) EnforcePppoeService está wired con el EnforcementGateway', () => {
    expect(appSrc).toMatch(/new EnforcePppoeService\(/);
  });

  it('(f) PerNasEnforcementGateway rutea el enforcement (MK-directo + RADIUS)', () => {
    expect(appSrc).toMatch(/new PerNasEnforcementGateway\(/);
  });

  it('(f) OrchestratorEnforcementAdapter está wired (camino RADIUS)', () => {
    expect(appSrc).toMatch(/new OrchestratorEnforcementAdapter\(/);
  });

  it('(f) HttpRadiusOrchestratorGateway está wired con config.orchestrator', () => {
    expect(appSrc).toMatch(/new HttpRadiusOrchestratorGateway\([^)]*config\.orchestrator/s);
  });

  it('(f) PreviewEnforcement está wired', () => {
    expect(appSrc).toMatch(/new PreviewEnforcement\(/);
  });

  it('(f) RunBulkEnforcement está wired', () => {
    expect(appSrc).toMatch(/new RunBulkEnforcement\(/);
  });

  it('(f) ServiceCutRunner está wired con PgAdvisoryLock', () => {
    expect(appSrc).toMatch(/new ServiceCutRunner\([^)]*new PgAdvisoryLock\(\)/s);
  });

  it('(f) PrismaServiceCutBatchRepository está instanciado', () => {
    expect(appSrc).toMatch(/new PrismaServiceCutBatchRepository\(\)/);
  });

  it('(g) createPppoeRouter recibe sessionRepo (auth STATEFUL — sesión revocada no puede cortar)', () => {
    expect(appSrc).toMatch(/createPppoeRouter\(\s*authAdapter,\s*sessionRepo/);
  });

  // ── pppoe-contract-integrity (#1/#2/#4) ────────────────────────────────────
  it('(h) EnsureInternetContractService está wired (helper de reconcile INTERNET)', () => {
    expect(appSrc).toMatch(/new EnsureInternetContractService\(/);
  });

  it('(h) DeassociatePppoeFromContract está wired', () => {
    expect(appSrc).toMatch(/new DeassociatePppoeFromContract\(/);
  });

  // ── pppoe-baja-motivo ──────────────────────────────────────────────────────
  it('(i) PrismaContractServiceEventRepository wired en EnsureInternetContractService (pppoe-baja-motivo)', () => {
    // Verificar que el eventRepo está en el bloque PPPoE (junto con EnsureInternetContractService)
    const pppoeBlockStart = appSrc.indexOf('pppoe-contract-integrity');
    const pppoeBlockEnd   = appSrc.indexOf('// ─── #80 Recaptación');
    const pppoeBlock = appSrc.slice(pppoeBlockStart, pppoeBlockEnd);
    expect(pppoeBlock).toMatch(/new PrismaContractServiceEventRepository\(\)/);
  });

  // ── pppoe-corte-individual ─────────────────────────────────────────────────
  it('(j) RecordPppoeEnforceEvent wired e INYECTADO como arg de EnforcePppoeService (pppoe-corte-individual)', () => {
    // Se construye...
    expect(appSrc).toMatch(/const recordEnforceEvent = new RecordPppoeEnforceEvent\(/);
    // ...Y se inyecta en EnforcePppoeService (no basta con construirlo: si no se pasa, el log se pierde en silencio).
    expect(appSrc).toMatch(/new EnforcePppoeService\([^)]*recordEnforceEvent\s*\)/s);
  });

  // ── pppoe-terminate-callerid ───────────────────────────────────────────────
  it('(k) TerminatePppoeService wired en createPppoeRouter (pppoe-terminate-callerid)', () => {
    expect(appSrc).toMatch(/new TerminatePppoeService\(/);
  });

  it('(k) GetPppoeCallerId wired en createPppoeRouter (pppoe-terminate-callerid)', () => {
    expect(appSrc).toMatch(/new GetPppoeCallerId\(/);
  });

  // ── fix-wave-2 (CRITICAL): RenamePppoeUsername usa radiusEnforcement, NO enforcementGw ──
  it('(m) RenamePppoeUsername wired con nasRepoForPppoe y radiusEnforcement (fix-wave-2 CRITICAL)', () => {
    // El rename es SOLO-RADIUS: el enforcement debe ir por OrchestratorEnforcementAdapter
    // (radiusEnforcement) directo — NO por el PerNasEnforcementGateway (enforcementGw),
    // que con {} as NasServer ruteaba a RouterOsEnforcementAdapter → 500 en prod.
    expect(appSrc).toMatch(/new RenamePppoeUsername\([^)]*nasRepoForPppoe[^)]*radiusEnforcement\s*\)/s);
  });

  it('(m) CreatePppoeStandalone wired (pppoe-full-management Fase 2)', () => {
    expect(appSrc).toMatch(/new CreatePppoeStandalone\(/);
  });

  // ── pppoe-move-nas W1 — anti "feature muerta": move radius-aware + registro visible wired ──
  it('(n) MovePppoeToNas construido con findFreeIp y el legacy move como delegate (pppoe-move-nas)', () => {
    // Se construye con el allocator (IP nueva del pool cgnat del destino)...
    expect(appSrc).toMatch(/const movePppoeToNas = new MovePppoeToNas\(/);
    expect(appSrc).toMatch(/new MovePppoeToNas\([^;]*findFreeIp/s);
    // ...y con el flujo legacy como colaborador (rama NAS no-radius).
    expect(appSrc).toMatch(/new MovePppoeToNas\([^;]*legacyMovePppoe/s);
  });

  it('(n) movePppoeToNas INYECTADO en createPppoeRouter (sin esto la ruta cae al legacy pre-HA)', () => {
    // fix wave 1 (ajuste 8d): ventana ACOTADA a la llamada de createPppoeRouter (patrón del test b)
    // — el [\s\S]* anterior escaneaba hasta EOF y matcheaba un movePppoeToNas de cualquier otro lado.
    // mini fix wave (ajuste 11): la ventana corta en el `));` de CIERRE del call, no en un largo
    // fijo — el margen de 4000 chars se agotaba con ~2 use cases más en la lista de args.
    const idx = appSrc.indexOf('createPppoeRouter(');
    expect(idx).toBeGreaterThan(-1);
    const end = appSrc.indexOf('));', idx);
    expect(end).toBeGreaterThan(idx);
    const window = appSrc.slice(idx, end + '));'.length);
    expect(window).toMatch(/movePppoeToNas,/);
  });

  it('(n) PrismaPppoeNasMoveEventRepository instanciado (registro visible de movimientos)', () => {
    expect(appSrc).toMatch(/new PrismaPppoeNasMoveEventRepository\(\)/);
  });

  it('(n) ListPppoeNasMoveEvents wired con el repo de eventos y pasado a createPppoeRouter', () => {
    expect(appSrc).toMatch(/new ListPppoeNasMoveEvents\(\s*nasMoveEventRepo/);
    expect(appSrc).toMatch(/createPppoeRouter\([\s\S]*new ListPppoeNasMoveEvents\(/);
  });

  // ── pppoe-search-bulk-plan — anti "feature muerta" (lección W6): bulk change-plan wired ──
  it('(n) BulkChangePppoePlan wired en createPppoeRouter (pppoe-search-bulk-plan)', () => {
    // Si no se construye e inyecta, POST /api/pppoe/bulk/change-plan responde 404 y la feature queda muerta.
    expect(appSrc).toMatch(/new BulkChangePppoePlan\(/);
  });

  it('(n) BulkChangePppoePlan recibe PrismaPlanRepository (fail-fast del plan contra el catálogo real)', () => {
    expect(appSrc).toMatch(/new BulkChangePppoePlan\([\s\S]*?new PrismaPlanRepository\(\)/);
  });

  it('(n) ChangePppoePlanService construido con catálogo + eventRepo reales (evento modified por ítem)', () => {
    expect(appSrc).toMatch(
      /new ChangePppoePlanService\([\s\S]*?new PrismaServiceCatalogRepository\(\),[\s\S]*?new PrismaContractServiceEventRepository\(\)/,
    );
  });

  // ── pppoe-bulk-select-filter (v2) — anti "feature muerta" (lección W6): GET /pppoe/ids wired ──
  it('(o) ListAllPppoeServiceIds está IMPORTADO en app.ts (pppoe-bulk-select-filter)', () => {
    expect(appSrc).toMatch(/import.*ListAllPppoeServiceIds.*from.*ListAllPppoeServiceIds/);
  });

  it('(o) ListAllPppoeServiceIds construido con pppoeRepo e INYECTADO en createPppoeRouter', () => {
    // Si no se construye e inyecta, GET /api/pppoe/ids responde 404 y la feature queda muerta.
    expect(appSrc).toMatch(/new ListAllPppoeServiceIds\(\s*pppoeRepo\s*\)/);

    const idx = appSrc.indexOf('createPppoeRouter(');
    expect(idx).toBeGreaterThan(-1);
    const end = appSrc.indexOf('));', idx);
    expect(end).toBeGreaterThan(idx);
    const window = appSrc.slice(idx, end + '));'.length);
    expect(window).toMatch(/new ListAllPppoeServiceIds\(/);
  });

  // ── pppoe-preprovision-autoinstall (tasks 1.5) — anti "feature muerta": el allocator
  // server-side de la creación (S1.4) tiene que llegar INYECTADO a ambos use cases de alta.
  // Sin el findFreeIp, la rama "NAS radius sin pool-mode y sin IP" degrada silenciosamente al
  // comportamiento viejo (fixed con framedIp null) y la preferencia de tipo de IP queda muerta.
  it('(q) pppoe-preprovision: CreatePppoeService recibe findFreeIp (allocator server-side del alta)', () => {
    expect(appSrc).toMatch(/const createPppoeSvc = new CreatePppoeService\([^;]*findFreeIp/s);
  });

  it('(q) pppoe-preprovision: CreatePppoeStandalone recibe findFreeIp (mismo allocator en el alta standalone)', () => {
    expect(appSrc).toMatch(/new CreatePppoeStandalone\([^)]*findFreeIp/s);
  });

  // ── service-transfer W2 — anti "feature muerta" (lección W6): TransferPppoe wired ─────────
  it('(r) service-transfer: TransferPppoe COMPONE las instancias singleton (createPppoeSvc + terminatePppoeSvc, no instancias paralelas)', () => {
    expect(appSrc).toMatch(/const transferPppoe = new TransferPppoe\([\s\S]*?createPppoeSvc,[\s\S]*?terminatePppoeSvc,/);
  });

  it('(r) service-transfer: terminatePppoeSvc es UNA instancia compartida entre el router (DELETE) y TransferPppoe (recreate)', () => {
    // Se extrae a variable...
    expect(appSrc).toMatch(/const terminatePppoeSvc = new TerminatePppoeService\(/);
    // ...y la MISMA variable viaja a createPppoeRouter (ventana acotada al call, patrón test n).
    const idx = appSrc.indexOf('createPppoeRouter(');
    expect(idx).toBeGreaterThan(-1);
    const end = appSrc.indexOf('));', idx);
    expect(end).toBeGreaterThan(idx);
    const window = appSrc.slice(idx, end + '));'.length);
    expect(window).toMatch(/terminatePppoeSvc,/);
  });

  it('(r) service-transfer: transferPppoe INYECTADO en createPppoeRouter (sin esto POST /pppoe/:id/transfer responde 404)', () => {
    const idx = appSrc.indexOf('createPppoeRouter(');
    expect(idx).toBeGreaterThan(-1);
    const end = appSrc.indexOf('));', idx);
    expect(end).toBeGreaterThan(idx);
    const window = appSrc.slice(idx, end + '));'.length);
    expect(window).toMatch(/transferPppoe,/);
  });

  it('(r) service-transfer: el lookup de contrato de TransferPppoe usa prismaContractClientNameLookup (ownership + nombre del cliente)', () => {
    expect(appSrc).toMatch(/new TransferPppoe\([\s\S]*?prismaContractClientNameLookup/);
  });
});

// ── pppoe-move-nas W2 — watcher auto-move: anti "feature muerta" (lección W6) ─────────────────
// El scheduler sigue el patrón EXACTO de radius-auth-ingest, cuyo composition root vive en
// main.ts + scheduling/bootstrap* (NO en app.ts: el watcher no tiene superficie HTTP propia).
// Estas aserciones pinean ese wiring: sin bootstrap en main.ts el watcher jamás arranca; sin
// el seed del flag, 'pppoe-auto-move' no aparece en la Config UI y nadie puede prenderlo.
describe('PPPoE auto-move watcher composition (pppoe-move-nas W2)', () => {
  let mainSrc: string;
  let bootstrapSrc: string;
  let configSrc: string;

  beforeAll(() => {
    const srcRoot = join(__dirname, '..', '..');
    mainSrc      = readFileSync(join(srcRoot, 'main.ts'), 'utf8');
    bootstrapSrc = readFileSync(join(srcRoot, 'infrastructure', 'scheduling', 'bootstrapPppoeAutoMove.ts'), 'utf8');
    configSrc    = readFileSync(join(srcRoot, 'infrastructure', 'config.ts'), 'utf8');
  });

  it('(o) main.ts bootstrapea el scheduler fire-and-forget y lo arranca (patrón radius-auth-ingest)', () => {
    expect(mainSrc).toMatch(/import \{ bootstrapPppoeAutoMove \}/);
    expect(mainSrc).toMatch(/void bootstrapPppoeAutoMove\(\)[\s\S]{0,200}scheduler\?\.start\(\)/);
  });

  it('(o) el bootstrap construye AutoMovePppoe con el MovePppoeToNas radius-aware de W1 (no un move paralelo)', () => {
    expect(bootstrapSrc).toMatch(/new MovePppoeToNas\(/);
    expect(bootstrapSrc).toMatch(/new AutoMovePppoe\([\s\S]*?movePppoeToNas/);
  });

  it('(o) el scheduler recibe el flag repo REAL + lock advisory (gate por tick y un solo tick cross-replica)', () => {
    expect(bootstrapSrc).toMatch(/new PppoeAutoMoveScheduler\(/);
    expect(bootstrapSrc).toMatch(/new PrismaFeatureFlagRepository\(\)/);
    expect(bootstrapSrc).toMatch(/new PgAdvisoryLock\(\)/);
  });

  it('(o) el intervalo viene de config.pppoeAutoMove (AUTO_MOVE_INTERVAL_MS, default 120000 = 2 min)', () => {
    expect(bootstrapSrc).toMatch(/config\.pppoeAutoMove\.intervalMs/);
    // Anclar al USO real de la env var (el nombre también aparece antes en el doc comment).
    const idx = configSrc.indexOf('process.env.AUTO_MOVE_INTERVAL_MS');
    expect(idx).toBeGreaterThan(-1);
    const window = configSrc.slice(idx, idx + 300);
    expect(window).toMatch(/default:\s*120_000/);
    expect(window).toMatch(/min:\s*15_000/);
    expect(window).toMatch(/max:\s*86_400_000/);
  });

  it("(o) migración idempotente seedea el flag 'pppoe-auto-move' en OFF (visible/toggleable en la Config UI)", () => {
    const migrationSrc = readFileSync(
      join(__dirname, '..', '..', '..', 'prisma', 'migrations', '20260825000000_pppoe_auto_move_flag', 'migration.sql'),
      'utf8',
    );
    expect(migrationSrc).toMatch(/'pppoe-auto-move',\s*false/);
    expect(migrationSrc).toMatch(/ON CONFLICT DO NOTHING/);
  });

  // ── D-W2.5 — endurecimiento post-review W2 ─────────────────────────────────────────────────
  it('(p) D-W2.5: el gateway del bootstrap sale de config.orchestrator (baseUrl+token+timeoutMs)', () => {
    expect(bootstrapSrc).toMatch(/const \{ baseUrl, token \} = config\.orchestrator/);
    expect(bootstrapSrc).toMatch(
      /new HttpRadiusOrchestratorGateway\(\{\s*baseUrl,\s*token,\s*timeoutMs:\s*config\.orchestrator\.timeoutMs\s*\}\)/,
    );
  });

  it('(p) D-W2.5: el bootstrap inyecta el tuning de config.pppoeAutoMove en AutoMovePppoe (breaker/cap/cooldown/freshness)', () => {
    // Sin esta inyección las envs AUTO_MOVE_* quedan muertas: el use case usaría sus defaults
    // internos y el operador no podría calibrar el breaker sin redeploy.
    expect(bootstrapSrc).toMatch(/new AutoMovePppoe\([\s\S]*?abortThreshold:\s*config\.pppoeAutoMove\.abortThreshold/);
    expect(bootstrapSrc).toMatch(/maxMovesPerTick:\s*config\.pppoeAutoMove\.maxMovesPerTick/);
    expect(bootstrapSrc).toMatch(/cooldownMs:\s*config\.pppoeAutoMove\.cooldownMs/);
    expect(bootstrapSrc).toMatch(/sessionFreshnessMs:\s*config\.pppoeAutoMove\.sessionFreshnessMs/);
  });

  it('(p) D-W2.5: config.ts declara las envs del endurecimiento con parse seguro y los defaults del design (25/10/10min/72h)', () => {
    const at = configSrc.indexOf('process.env.AUTO_MOVE_ABORT_THRESHOLD');
    expect(at).toBeGreaterThan(-1);
    expect(configSrc.slice(at, at + 120)).toMatch(/default:\s*25/);

    const mm = configSrc.indexOf('process.env.AUTO_MOVE_MAX_MOVES_PER_TICK');
    expect(mm).toBeGreaterThan(-1);
    expect(configSrc.slice(mm, mm + 120)).toMatch(/default:\s*10/);

    const cd = configSrc.indexOf('process.env.AUTO_MOVE_COOLDOWN_MS');
    expect(cd).toBeGreaterThan(-1);
    expect(configSrc.slice(cd, cd + 160)).toMatch(/default:\s*600_000/);

    const fr = configSrc.indexOf('process.env.AUTO_MOVE_SESSION_FRESHNESS_MS');
    expect(fr).toBeGreaterThan(-1);
    expect(configSrc.slice(fr, fr + 160)).toMatch(/default:\s*259_200_000/);
  });

  it('(p) D-W2.5: env.example documenta TODAS las envs del watcher (interval + breaker + cap + cooldown + freshness)', () => {
    const envSrc = readFileSync(join(__dirname, '..', '..', '..', 'env.example'), 'utf8');
    for (const v of [
      'AUTO_MOVE_INTERVAL_MS',
      'AUTO_MOVE_ABORT_THRESHOLD',
      'AUTO_MOVE_MAX_MOVES_PER_TICK',
      'AUTO_MOVE_COOLDOWN_MS',
      'AUTO_MOVE_SESSION_FRESHNESS_MS',
    ]) {
      expect(envSrc).toMatch(new RegExp(`^${v}=`, 'm'));
    }
  });
});
