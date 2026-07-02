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

  // ── pppoe-pool-ip (Fase 1) — anti "feature muerta": pin/unpin/pool-mode wired ──
  it('(l) PinPppoeIp wired en createPppoeRouter (pppoe-pool-ip)', () => {
    expect(appSrc).toMatch(/new PinPppoeIp\(/);
  });

  it('(l) UnpinPppoeIp wired en createPppoeRouter (pppoe-pool-ip)', () => {
    expect(appSrc).toMatch(/new UnpinPppoeIp\(/);
  });

  it('(l) SetNasPoolMode wired y pasado a createNasRouter (pppoe-pool-ip)', () => {
    // Se construye con el orchestrator (pre-check del radippool)...
    expect(appSrc).toMatch(/const setNasPoolMode = new SetNasPoolMode\(/);
    // ...Y se inyecta en createNasRouter (si no se pasa, la ruta /pool-mode queda muerta).
    expect(appSrc).toMatch(/createNasRouter\([\s\S]*setNasPoolMode/);
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
});
