/**
 * suricata-tickets-mirror (task A.7, D8) — composition-root test, molde
 * `external-bulk-messaging-composition.test.ts` (a) "assertions estáticas".
 *
 * Fase A es un SLICE 0 dark: `composeSuricataModule`/`composeSuricataExternalModule`
 * devuelven 501 para todo. La ÚNICA invariante real de esta fase (D8) es de
 * ORDEN: si el mount de `/api/external/v1/suricata` quedara DESPUÉS del mount
 * GLOBAL `/api/external/v1`, la key GLOBAL interceptaría el prefijo dedicado y
 * la key de `config.suricata.externalApiKey` (Fase D) nunca se evaluaría —
 * mismo incidente ya documentado para `external-bulk-messaging`. Por eso este
 * test lee el FUENTE de `app.ts` (ningún test de este repo importa `app.ts` —
 * ver la nota de `assistant-composition.test.ts` / `external-bulk-messaging-composition.test.ts`
 * sobre por qué: levantaría media aplicación).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('suricata-tickets-mirror composition root — assertions estáticas (D8)', () => {
  let appSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8');
  });

  it('composeSuricataModule y composeSuricataExternalModule están importados', () => {
    expect(appSrc).toMatch(
      /import\s*\{\s*composeSuricataModule\s*\}\s*from\s*['"]\.\/composeSuricataModule['"]/,
    );
    expect(appSrc).toMatch(
      /import\s*\{\s*composeSuricataExternalModule\s*\}\s*from\s*['"]\.\/composeSuricataExternalModule['"]/,
    );
  });

  it('el mount interno existe y pasa authAdapter/sessionRepo/requirePerm (D8, sin re-derivar un 2º rbacUserRepo)', () => {
    expect(appSrc).toMatch(
      /app\.use\('\/api\/suricata',\s*composeSuricataModule\(\{\s*authAdapter,\s*sessionRepo,\s*requirePerm\s*\}\)\)/,
    );
  });

  it('el mount interno queda montado DESPUÉS de /api/assistant (D8: "INMEDIATAMENTE DESPUÉS del mount de /api/assistant")', () => {
    const assistantIdx = appSrc.indexOf("app.use('/api/assistant',");
    const internalIdx = appSrc.indexOf("app.use('/api/suricata',");

    expect(assistantIdx).toBeGreaterThan(-1);
    expect(internalIdx).toBeGreaterThan(-1);
    expect(assistantIdx).toBeLessThan(internalIdx);
  });

  it('el marcador de fin del mount interno existe (ancla para futuras ventanas recortadas, molde fix wave F1 R3 #5)', () => {
    expect(appSrc).toContain('[suricata-internal-mount-end]');
  });

  it('el marcador de fin del mount externo existe', () => {
    expect(appSrc).toContain('[suricata-external-mount-end]');
  });

  it('CRÍTICO — el mount de /api/external/v1/suricata queda ANTES (índice MENOR) que el mount global /api/external/v1', () => {
    const suricataExternalIdx = appSrc.indexOf("app.use('/api/external/v1/suricata',");
    const globalExternalIdx = appSrc.indexOf("app.use('/api/external/v1',");

    expect(suricataExternalIdx).toBeGreaterThan(-1);
    expect(globalExternalIdx).toBeGreaterThan(-1);
    expect(suricataExternalIdx).toBeLessThan(globalExternalIdx);
  });

  it('el mount externo invoca composeSuricataExternalModule() (Slice 0 — sin key dedicada todavía, ver comentario D8)', () => {
    expect(appSrc).toMatch(
      /app\.use\('\/api\/external\/v1\/suricata',\s*composeSuricataExternalModule\(\)\)/,
    );
  });
});
