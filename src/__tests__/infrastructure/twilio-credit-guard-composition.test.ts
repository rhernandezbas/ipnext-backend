/**
 * twilio-credit-guard (task 3.7, D6, D10.g) — composition-root test, molde
 * `external-bulk-messaging-composition.test.ts` (parte a): assertions
 * ESTÁTICAS sobre el FUENTE de `app.ts`. Ningún test de este repo bootea
 * `createApp()` real (importar `app.ts` levanta Prisma/schedulers/adapters
 * HTTP — dejaría de ser barato y determinístico); se sigue el patrón real.
 *
 * `app.ts` es el punto de colisión declarado (D10.g): este test es el que
 * detecta un mount fuera de lugar o — desde la fix wave F1 (R2 #4) — una
 * SEGUNDA instancia de `TwilioCreditBalanceGateway`, que partiría en dos la
 * cache de 60s del saldo (dos verdades simultáneas sobre la misma plata, y una
 * invalidación post-send que solo alcanza a una de ellas).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('twilio-credit-guard composition root — assertions estáticas (D6)', () => {
  let appSrc: string;
  const MOUNT_END = '[external-bulk-mount-end]';
  const BLOCK_START = 'const externalBulkPreviewRepo = new PrismaExternalBulkPreviewRepository();';
  let mountWindow: string;
  /** Bloque del router admin de tarifas, recortado por ANCLAS, no por longitud fija (R2 #7). */
  let ratesRouteBlock: string;

  /** Quita las líneas de comentario para que ningún `not.toMatch` se satisfaga por una mención en prosa. */
  function stripComments(raw: string): string {
    return raw
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');
  }

  beforeAll(() => {
    appSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8');

    const start = appSrc.indexOf(BLOCK_START);
    const end = appSrc.indexOf(MOUNT_END, start);
    mountWindow = stripComments(start > -1 && end > start ? appSrc.slice(start, end) : '');

    // fix wave F1 (R2 #7) — el slice de 900 caracteres fijo SE ELIMINÓ. Un
    // `expect(block).not.toMatch(...)` sobre una ventana de longitud arbitraria
    // pasa por VACUIDAD apenas el bloque crece un renglón: la línea prohibida
    // simplemente queda fuera del recorte y nadie se entera. Ahora el corte va
    // del mount de `/api/messaging/config/rates` hasta el SIGUIENTE `app.use(`
    // — el final REAL del bloque, sea del largo que sea.
    const ratesIdx = appSrc.indexOf("app.use('/api/messaging/config/rates'");
    const nextMount = appSrc.indexOf('app.use(', ratesIdx + 10);
    ratesRouteBlock = stripComments(
      ratesIdx > -1 ? appSrc.slice(ratesIdx, nextMount > ratesIdx ? nextMount : appSrc.length) : '',
    );
  });

  it('el marcador [external-bulk-mount-end] SIGUE presente sin modificar (pin heredado de external-bulk-messaging)', () => {
    expect(appSrc).toContain(MOUNT_END);
    expect(mountWindow.length).toBeGreaterThan(500);
  });

  it('la ventana del router de tarifas está ANCLADA a su final real, no a un largo fijo (R2 #7)', () => {
    expect(ratesRouteBlock.length).toBeGreaterThan(200);
    // Cierra ANTES del siguiente mount: la ventana no se come el router vecino.
    expect(ratesRouteBlock).not.toContain("app.use('/api/portfolio'");
    // Y contiene el cierre del propio `app.use(...)`.
    expect(ratesRouteBlock).toContain('));');
  });

  it('createMessagingRatesConfigRouter está importado', () => {
    expect(appSrc).toMatch(
      /import\s*\{\s*createMessagingRatesConfigRouter\s*\}\s*from\s*['"]\.\/routes\/messaging-rates-config\.routes['"]/,
    );
  });

  it('el mount de /api/messaging/config/rates existe', () => {
    expect(appSrc).toContain("app.use('/api/messaging/config/rates'");
  });

  it('el mount de /api/messaging/config/rates queda DESPUÉS del de /api/messaging/config/external-bulk (D6, bloque pegado)', () => {
    const externalBulkConfigIdx = appSrc.indexOf("app.use('/api/messaging/config/external-bulk'");
    const ratesConfigIdx = appSrc.indexOf("app.use('/api/messaging/config/rates'");

    expect(externalBulkConfigIdx).toBeGreaterThan(-1);
    expect(ratesConfigIdx).toBeGreaterThan(-1);
    expect(externalBulkConfigIdx).toBeLessThan(ratesConfigIdx);
  });

  it('el router de config admin gatea GET con messaging:read y PUT con messaging:manage', () => {
    expect(ratesRouteBlock).toMatch(/read:\s*requirePerm\('messaging',\s*'read'\)/);
    expect(ratesRouteBlock).toMatch(/manage:\s*requirePerm\('messaging',\s*'manage'\)/);
  });

  /**
   * fix wave F1 (R2 #4) — EL pin del change: UNA sola instancia del gateway de
   * saldo en TODO `app.ts`. Dos instancias = dos caches de 60s sobre la misma
   * plata, y la invalidación post-send solo vacía una.
   */
  it('existe EXACTAMENTE UNA instanciación de TwilioCreditBalanceGateway en todo app.ts', () => {
    const source = stripComments(appSrc);
    const instantiations = (source.match(/new TwilioCreditBalanceGateway\(/g) ?? []).length;
    expect(instantiations).toBe(1);
  });

  it('existe EXACTAMENTE UNA instanciación de PrismaMessagingRatesConfigRepository en todo app.ts', () => {
    const source = stripComments(appSrc);
    const instantiations = (source.match(/new PrismaMessagingRatesConfigRepository\(\)/g) ?? []).length;
    expect(instantiations).toBe(1);
  });

  it('las dos instancias compartidas se declaran ANTES del bloque bulk (hoisted, alcanzables por ambos mounts)', () => {
    const creditDeclIdx = appSrc.indexOf('const creditBalancePort = new TwilioCreditBalanceGateway(');
    const ratesDeclIdx = appSrc.indexOf('const messagingRatesRepo = new PrismaMessagingRatesConfigRepository()');
    const bulkBlockIdx = appSrc.indexOf(BLOCK_START);
    const ratesRouteIdx = appSrc.indexOf("app.use('/api/messaging/config/rates'");

    expect(creditDeclIdx).toBeGreaterThan(-1);
    expect(ratesDeclIdx).toBeGreaterThan(-1);
    expect(creditDeclIdx).toBeLessThan(bulkBlockIdx);
    expect(ratesDeclIdx).toBeLessThan(bulkBlockIdx);
    expect(creditDeclIdx).toBeLessThan(ratesRouteIdx);
  });

  it('ValidateExternalBulk recibe creditBalancePort + messagingRatesRepo (scan de fuente)', () => {
    const validateIdx = mountWindow.indexOf('validateExternalBulk: new ValidateExternalBulk(');
    expect(validateIdx).toBeGreaterThan(-1);
    const validateBlock = mountWindow.slice(validateIdx, validateIdx + 400);
    expect(validateBlock).toMatch(/creditBalancePort,/);
    expect(validateBlock).toMatch(/messagingRatesRepo,/);
  });

  it('SendExternalBulk TAMBIÉN recibe creditBalancePort/messagingRatesRepo — no una firma vieja de 10 args', () => {
    const sendIdx = mountWindow.indexOf('sendExternalBulk: new SendExternalBulk(');
    expect(sendIdx).toBeGreaterThan(-1);
    const sendBlock = mountWindow.slice(sendIdx, sendIdx + 400);
    expect(sendBlock).toMatch(/creditBalancePort,/);
    expect(sendBlock).toMatch(/messagingRatesRepo,/);
  });

  it('getMessagingCredit del router EXTERNO usa la instancia compartida', () => {
    expect(mountWindow).toMatch(/getMessagingCredit:\s*new GetMessagingCredit\(creditBalancePort,\s*messagingRatesRepo\)/);
  });

  /**
   * fix wave F1 (R2 #4) — el router de config ADMIN usa las MISMAS instancias
   * que el bloque bulk. La versión anterior pineaba exactamente lo contrario
   * (`creditPortForRoute`/`messagingRatesRepoForRoute` propias): ese pin era el
   * bug, no la protección.
   */
  it('el router de config admin (/api/messaging/config/rates) usa las instancias COMPARTIDAS', () => {
    expect(ratesRouteBlock).toMatch(/new GetMessagingRatesConfig\(messagingRatesRepo\)/);
    expect(ratesRouteBlock).toMatch(/new SetMessagingRatesConfig\(messagingRatesRepo\)/);
    expect(ratesRouteBlock).toMatch(/new GetMessagingCredit\(creditBalancePort,\s*messagingRatesRepo\)/);
  });

  it('el router de config admin NO instancia gateways/repos propios (las variables *ForRoute murieron)', () => {
    expect(ratesRouteBlock).not.toMatch(/new TwilioCreditBalanceGateway\(/);
    expect(ratesRouteBlock).not.toMatch(/new PrismaMessagingRatesConfigRepository\(/);
    expect(stripComments(appSrc)).not.toContain('creditPortForRoute');
    expect(stripComments(appSrc)).not.toContain('messagingRatesRepoForRoute');
  });
});
