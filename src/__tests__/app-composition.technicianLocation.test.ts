import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Composition-root test ESTÁTICO del change `iclass-gps-audit`.
 *
 * ## Por qué existe y por qué lee el código fuente
 *
 * Lección de la Wave 6 del EPIC #38: el apply cableó las rutas pero NO inyectó el hook
 * en `app.ts`. Los parámetros eran opcionales y los tests de ruta inyectan su propio
 * wiring, así que **el CI quedó verde con la feature MUERTA en producción**.
 *
 * Los tests de ruta de este change (technicianLocation.routes.test.ts) tienen el mismo
 * punto ciego: arman su propio router con guards de mentira. Ninguno puede ver si
 * `app.ts` realmente montó el router, con los permisos correctos y con autenticación.
 *
 * Por eso estas assertions son sobre el TEXTO de `app.ts`. Es tosco a propósito: es la
 * única forma de pinear el wiring sin levantar la app entera con una DB real.
 */

const APP_SOURCE = readFileSync(
  join(__dirname, '..', 'infrastructure', 'http', 'app.ts'),
  'utf8',
);

describe('app.ts wiring — technician location & presence audit', () => {
  it('imports the router', () => {
    expect(APP_SOURCE).toContain("import { createTechnicianLocationRouter } from './routes/technicianLocation.routes'");
  });

  it('mounts the router at /api/technicians', () => {
    expect(APP_SOURCE).toMatch(/app\.use\(\s*'\/api\/technicians',\s*createTechnicianLocationRouter\(/);
  });

  it('wires the REAL Prisma repository, not an in-memory stub', () => {
    expect(APP_SOURCE).toContain('new PrismaTeamLocationRepository()');
    expect(APP_SOURCE).not.toMatch(
      /createTechnicianLocationRouter\([\s\S]{0,800}InMemoryTeamLocationRepository/,
    );
  });

  it('wires all four use cases', () => {
    const block = technicianRouterBlock();
    expect(block).toContain('new GetTeamsLiveStatus(');
    expect(block).toContain('new GetTeamDailyJourney(');
    expect(block).toContain('new AuditServiceOrderPresence(');
    expect(block).toContain('new ListSuspiciousClosures(');
  });

  it('gates the live map with technicians.location_read', () => {
    expect(technicianRouterBlock()).toMatch(
      /requireLocationRead:\s*requirePerm\('technicians',\s*'location_read'\)/,
    );
  });

  it('gates the audit with the SEPARATE technicians.location_audit permission', () => {
    expect(technicianRouterBlock()).toMatch(
      /requireLocationAudit:\s*requirePerm\('technicians',\s*'location_audit'\)/,
    );
  });

  it('does NOT reuse the same permission for both gates', () => {
    // El bug que este test previene: cablear location_read en los dos guards, lo que
    // le daría a despacho la auditoría histórica de personas sin que nadie lo note.
    const block = technicianRouterBlock();
    const read = block.match(/requireLocationRead:\s*requirePerm\('technicians',\s*'(\w+)'\)/)?.[1];
    const audit = block.match(/requireLocationAudit:\s*requirePerm\('technicians',\s*'(\w+)'\)/)?.[1];
    expect(read).toBeDefined();
    expect(audit).toBeDefined();
    expect(read).not.toBe(audit);
  });

  it('passes the auth provider so the permission guard has a user to check', () => {
    // Sin autenticación `req.user` no existe y el guard no puede gatear nada.
    expect(technicianRouterBlock()).toMatch(/authProvider:\s*authAdapter/);
  });

  it('passes sessionRepo so session REVOCATION actually applies (hallazgo 3.2)', () => {
    // `createAuthMiddleware` es stateful SÓLO si recibe sessionRepo. Sin él, revocar la
    // sesión de un ex-empleado no le cierra estas rutas: el JWT sigue vivo hasta 8 h.
    // Éste era el único de ~30 montajes del repo que no lo pasaba.
    expect(technicianRouterBlock()).toMatch(/sessionRepo\s*,/);
  });

  it('mounts /api/technicians EXACTLY ONCE (a previous mount would shadow these routes)', () => {
    // El `indexOf` de las otras assertions toma la PRIMERA ocurrencia: si mañana alguien
    // monta otro router en el mismo prefijo más arriba, Express resolvería por orden de
    // registro y estas rutas quedarían tapadas con el test en verde.
    const mounts = APP_SOURCE.match(/app\.use\(\s*'\/api\/technicians'/g) ?? [];
    expect(mounts).toHaveLength(1);
  });

  it('only mounts the feature when an IClass location source is available', () => {
    expect(APP_SOURCE).toContain('const teamLocationSource = buildTeamLocationSource()');
    expect(APP_SOURCE).toMatch(/if\s*\(teamLocationSource\)\s*\{/);
  });
});

/** El bloque de texto del mount, para acotar las assertions y no matchear en otro lado. */
function technicianRouterBlock(): string {
  const start = APP_SOURCE.indexOf("app.use('/api/technicians'");
  expect(start).toBeGreaterThan(-1);
  return APP_SOURCE.slice(start, start + 1400);
}
