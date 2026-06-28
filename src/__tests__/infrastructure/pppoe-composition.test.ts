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
});
