/**
 * gigared-tv-cic-reuse (T7.2) — composition-root guard del wiring de la reutilización de CICs.
 *
 * ⚠️ ESTE TEST ES LA RAZÓN DE QUE LA FEATURE NO NAZCA MUERTA. Las dos dependencias nuevas de
 * `RegisterGigaredAccount` (`TvCicReuseEligibilityRepository` y `AuditEventRepository`) son
 * OPCIONALES por compatibilidad con los ~50 tests que ya construían el use case. Sin repo de
 * elegibilidad, el comportamiento degrada al filtro B1 original: NINGÚN cic estampado se
 * reutiliza y el alta sigue rota — con la suite entera en verde, porque los tests inyectan su
 * propio wiring.
 *
 * Es exactamente la trampa de la W6 del EPIC #38 (rutas cableadas, hook NO inyectado, CI verde,
 * prod muerto). NO borrar ni debilitar este archivo.
 *
 * Se lee el FUENTE de app.ts porque bootear createApp() necesita una DB viva (mismo patrón que
 * gigared-composition.test.ts). Los comentarios se STRIPEAN antes de matchear: si no, un
 * comentario que mencione el identificador satisface la aserción y el test miente.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

/** Quita comentarios de bloque y de línea para que el match sea sobre CÓDIGO REAL. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('gigared-tv-cic-reuse T7.2 — composition root', () => {
  let code: string;

  beforeAll(() => {
    const raw = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'),
      'utf8',
    );
    code = stripComments(raw);
  });

  it('el stripper funciona (si no, todo lo de abajo es teatro)', () => {
    expect(stripComments('const a = 1; // new RegisterGigaredAccount(x)')).not.toContain(
      'RegisterGigaredAccount',
    );
    expect(stripComments('/* new RegisterGigaredAccount(x) */ const a = 1;')).not.toContain(
      'RegisterGigaredAccount',
    );
    expect(stripComments("const url = 'http://x'; // hola")).toContain("'http://x'");
  });

  it('app.ts construye PrismaTvCicReuseEligibilityRepository', () => {
    expect(code).toMatch(/new PrismaTvCicReuseEligibilityRepository\(/);
  });

  it('RegisterGigaredAccount recibe el repo de elegibilidad — sin esto la feature está MUERTA', () => {
    const m = /new RegisterGigaredAccount\(([^)]*)\)/.exec(code);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/gigaredCicReuseEligibility/);
  });

  it('RegisterGigaredAccount recibe el repo de auditoría (AUD-1)', () => {
    const m = /new RegisterGigaredAccount\(([^)]*)\)/.exec(code);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/auditEventRepo/);
  });

  it('el ORDEN posicional es el correcto: … pick, elegibilidad, auditoría', () => {
    // Los argumentos son POSICIONALES: intercambiar dos deja el use case compilando y
    // silenciosamente roto. Se fija el orden relativo de los tres últimos.
    const m = /new RegisterGigaredAccount\(([^)]*)\)/.exec(code);
    const args = m![1].split(',').map(a => a.trim());
    const iElig = args.findIndex(a => /gigaredCicReuseEligibility/.test(a));
    const iAudit = args.findIndex(a => /auditEventRepo/.test(a));

    expect(iElig).toBeGreaterThan(-1);
    expect(iAudit).toBeGreaterThan(iElig);
    // 10º y 11º parámetro (1-based) del constructor.
    expect(iElig).toBe(9);
    expect(iAudit).toBe(10);
  });
});
