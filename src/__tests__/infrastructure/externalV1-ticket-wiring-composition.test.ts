/**
 * externalV1-ticket-wiring-composition.test.ts (external-create-ticket T3) —
 * assertion estática sobre app.ts, patrón `messaging-composition.test.ts`.
 * Anti-W6 "feature muerta en prod": POST /api/external/v1/tickets se monta SOLO
 * si el router recibe `ticketDeps` (createTicket + rbacUserRepo + ticketAreaRepo).
 * Como esos params son opcionales (para que los tests in-memory monten sin todo el
 * stack), si alguien los quita del mount en app.ts el endpoint DESAPARECE en prod
 * sin ningún error de compilación. Este test pinea el wiring real.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('External v1 ticket WRITE wiring (external-create-ticket T3)', () => {
  let appSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8');
  });

  it('(a) createExternalWriteRateLimiter está importado del módulo de rate limiters', () => {
    expect(appSrc).toMatch(
      /import\s*\{[^}]*createExternalWriteRateLimiter[^}]*\}\s*from\s*['"]\.\/middleware\/rateLimiters['"]/,
    );
  });

  it('(b) CRÍTICO — el mount de /api/external/v1 pasa los ticketDeps (sin esto POST /tickets no existe en prod)', () => {
    const idx = appSrc.indexOf("app.use('/api/external/v1'");
    expect(idx).toBeGreaterThan(-1);
    const end = appSrc.indexOf('}));', idx);
    expect(end).toBeGreaterThan(idx);
    const window = appSrc.slice(idx, end + '}));'.length);

    expect(window).toMatch(/createExternalV1Router\(/);
    expect(window).toMatch(/\bcreateTicket\b/);
    expect(window).toMatch(/\brbacUserRepo\b/);
    expect(window).toMatch(/\bticketAreaRepo\b/);
  });

  it('(c) el POST externo lleva rate limiter dedicado (escritura pública con techo)', () => {
    const idx = appSrc.indexOf("app.use('/api/external/v1'");
    const end = appSrc.indexOf('}));', idx);
    const window = appSrc.slice(idx, end + '}));'.length);
    expect(window).toMatch(/rateLimiter:\s*createExternalWriteRateLimiter\(\)/);
  });
});

describe('External v1 NEWS WRITE wiring (external-news)', () => {
  let appSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8');
  });

  it('(a) CreateExternalNews está importado', () => {
    expect(appSrc).toMatch(
      /import\s*\{[^}]*CreateExternalNews[^}]*\}\s*from\s*['"]@application\/use-cases\/CreateExternalNews['"]/,
    );
  });

  it('(b) CRÍTICO — el mount de /api/external/v1 pasa los newsDeps (sin esto POST /news no existe en prod)', () => {
    const idx = appSrc.indexOf("app.use('/api/external/v1'");
    expect(idx).toBeGreaterThan(-1);
    const end = appSrc.indexOf('}));', idx);
    expect(end).toBeGreaterThan(idx);
    const window = appSrc.slice(idx, end + '}));'.length);

    expect(window).toMatch(/createExternalV1Router\(/);
    // newsDeps block: the orchestrating use case + the "api" author resolver.
    expect(window).toMatch(/\bcreateExternalNews\b/);
    expect(window).toMatch(/\brbacUserRepo\b/);
  });

  it('(c) el POST /news externo lleva su rate limiter dedicado (2 limiters: tickets + news)', () => {
    const idx = appSrc.indexOf("app.use('/api/external/v1'");
    const end = appSrc.indexOf('}));', idx);
    const window = appSrc.slice(idx, end + '}));'.length);
    // Both external writes (tickets + news) each carry their own rate limiter.
    const matches = window.match(/rateLimiter:\s*createExternalWriteRateLimiter\(\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
