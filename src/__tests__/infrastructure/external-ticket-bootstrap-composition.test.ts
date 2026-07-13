/**
 * external-ticket-bootstrap-composition.test.ts (external-create-ticket T1) —
 * assertion estática sobre main.ts + bootstrapGestionRealIngest.ts, patrón
 * `messaging-composition.test.ts`. Anti-"feature muerta / wiring roto en silencio"
 * (lección W6/#38).
 *
 * PINEA el desacople del usuario de sistema "Api" respecto de Gestión Real: el
 * reporter que el endpoint externo de tickets estampa DEBE existir SIEMPRE, no
 * solo cuando GR está prendido. Antes se sembraba SOLO dentro de
 * bootstrapGestionRealIngest, detrás de sus 2 early-returns (GR off → sin
 * reporter → el endpoint externo 500/orphan cuando GR se deprecie).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('External-ticket bootstrap composition root (T1 — desacople api reporter / GR)', () => {
  let mainSrc: string;
  let grIngestSrc: string;

  beforeAll(() => {
    mainSrc = readFileSync(join(__dirname, '..', '..', 'main.ts'), 'utf8');
    grIngestSrc = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'scheduling', 'bootstrapGestionRealIngest.ts'),
      'utf8',
    );
  });

  it('(a) main.ts importa bootstrapSystemUsers', () => {
    expect(mainSrc).toMatch(
      /import\s*\{\s*bootstrapSystemUsers\s*\}\s*from\s*['"]\.\/infrastructure\/bootstrap\/bootstrapSystemUsers['"]/,
    );
  });

  it('(b) main.ts AWAITea bootstrapSystemUsers (no fire-and-forget: el reporter debe existir antes de servir)', () => {
    expect(mainSrc).toMatch(/await\s+bootstrapSystemUsers\(/);
  });

  it('(b2) CRÍTICO — la llamada es INCONDICIONAL: statement top-level del IIFE (indent 2), NO envuelta en un if', () => {
    // El invariante CENTRAL del desacople: corre SIEMPRE, GR o no. Un
    // `if (flag) await bootstrapSystemUsers(...)` (o anidarlo en un bloque
    // condicional, indent >2) re-acoplaría EXACTAMENTE el bug que este cambio
    // arregla. Pineamos que la línea arranca como `await bootstrapSystemUsers(`
    // con la indentación top del async IIFE (2 espacios), no más adentro.
    const callLine = mainSrc.split('\n').find((l) => l.includes('bootstrapSystemUsers('));
    expect(callLine).toBeDefined();
    expect(callLine!).toMatch(/^ {2}await bootstrapSystemUsers\(/);
  });

  it('(c) CRÍTICO — bootstrapSystemUsers corre ANTES de createApp (reporter listo antes de aceptar requests)', () => {
    const bootstrapIdx = mainSrc.indexOf('bootstrapSystemUsers(');
    const createAppIdx = mainSrc.indexOf('createApp(');
    expect(bootstrapIdx).toBeGreaterThan(-1);
    expect(createAppIdx).toBeGreaterThan(-1);
    expect(bootstrapIdx).toBeLessThan(createAppIdx);
  });

  it('(d) CRÍTICO — bootstrapSystemUsers NO está acoplado a la config de GR (no vive dentro del .then de bootstrapGestionRealIngest)', () => {
    const bootstrapIdx = mainSrc.indexOf('bootstrapSystemUsers(');
    const grIngestIdx = mainSrc.indexOf('bootstrapGestionRealIngest()');
    expect(bootstrapIdx).toBeGreaterThan(-1);
    expect(grIngestIdx).toBeGreaterThan(-1);
    // El bootstrap de system users corre ANTES (arriba) del disparo fire-and-forget de GR.
    expect(bootstrapIdx).toBeLessThan(grIngestIdx);
  });

  it('(e) bootstrapGestionRealIngest.ts YA NO siembra el usuario api (no llama bootstrapApiUser) — desacople real', () => {
    expect(grIngestSrc).not.toMatch(/bootstrapApiUser\s*\(/);
  });

  it('(f) el ingest de GR sigue resolviendo el reporter por login en runtime (API_USER_LOGIN)', () => {
    expect(grIngestSrc).toMatch(/apiReporterLogin:\s*API_USER_LOGIN/);
  });
});
