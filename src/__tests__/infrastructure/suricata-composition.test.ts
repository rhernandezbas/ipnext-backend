/**
 * suricata-tickets-mirror (task A.7, updated Fase D task D.7, Fase E, D8) —
 * composition-root test, molde `external-bulk-messaging-composition.test.ts`
 * (a) "assertions estáticas".
 *
 * `composeSuricataModule` (panel interno) sigue en 501 salvo `POST
 * /tickets/:id/reply` (Fase E — el resto es Fase F). Fase D reemplazó el
 * Slice 0 dark del endpoint EXTERNO por la key dedicada real +
 * `machineActorMiddleware` — la invariante de ORDEN (D8) sigue siendo la
 * misma: si el mount de `/api/external/v1/suricata` quedara DESPUÉS del mount
 * GLOBAL `/api/external/v1`, la key GLOBAL interceptaría el prefijo dedicado y
 * `config.suricata.externalApiKey` nunca se evaluaría — mismo incidente ya
 * documentado para `external-bulk-messaging`. Por eso este test lee el FUENTE
 * de `app.ts` (ningún test de este repo importa `app.ts` — ver la nota de
 * `assistant-composition.test.ts` / `external-bulk-messaging-composition.test.ts`
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
      /app\.use\('\/api\/suricata',\s*composeSuricataModule\(\{\s*authAdapter,\s*sessionRepo,\s*requirePerm,\s*replyToSuricataTicket,\s*featureFlags:\s*suricataInternalFeatureFlagRepo,?\s*\}\)\)/,
    );
  });

  it('la Fase E wirea el guard conservador `UnavailableSuricataReplyPort` — NUNCA `PlaywrightSuricataReply` (Fase J pendiente)', () => {
    expect(appSrc).toContain('new UnavailableSuricataReplyPort()');
    expect(appSrc).not.toContain('new PlaywrightSuricataReply(');
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

  it('el mount externo aplica createApiKeyMiddleware(config.suricata.externalApiKey) (Fase D, D8)', () => {
    expect(appSrc).toMatch(
      /app\.use\(\s*'\/api\/external\/v1\/suricata',\s*createApiKeyMiddleware\(config\.suricata\.externalApiKey\)/,
    );
  });

  it('el mount externo aplica machineActorMiddleware(rbacUserRepo, API_SURICATA_USER_LOGIN) (Fase D, D8, auditoría)', () => {
    expect(appSrc).toContain('machineActorMiddleware(rbacUserRepo, API_SURICATA_USER_LOGIN)');
  });
});
