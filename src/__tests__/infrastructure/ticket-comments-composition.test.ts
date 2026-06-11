/**
 * #44 — composition-root static guard.
 *
 * Booting createApp() needs a live DB, so this asserts the wiring statically by
 * reading app.ts (and tickets.routes.ts) source — same pattern as
 * task-general-status-composition.test.ts.
 *
 *  1) The path-scoped 8mb JSON parser is registered BEFORE the global parser
 *     (otherwise the global 100kb parser rejects big bodies before the router runs).
 *  2) createTicketCommentsRouter(...) is wired with requirePerm('tickets','read'/'write').
 *  3) The legacy in-memory ticketRepliesStore and /replies routes are gone.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Ticket comments composition root (#44)', () => {
  let appSrc: string;
  let ticketsRoutesSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'),
      'utf8',
    );
    ticketsRoutesSrc = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'http', 'routes', 'tickets.routes.ts'),
      'utf8',
    );
  });

  it('registers the 8mb path-scoped parser BEFORE the global express.json()', () => {
    const scopedIdx = appSrc.indexOf("'8mb'");
    const globalIdx = appSrc.indexOf('app.use(express.json())');
    expect(scopedIdx).toBeGreaterThan(-1);
    expect(globalIdx).toBeGreaterThan(-1);
    expect(scopedIdx).toBeLessThan(globalIdx);
  });

  it("wires createTicketCommentsRouter with requirePerm('tickets','read'/'write')", () => {
    const callIdx = appSrc.indexOf('createTicketCommentsRouter(');
    expect(callIdx).toBeGreaterThan(-1);
    const callWindow = appSrc.slice(callIdx, callIdx + 1500);
    expect(callWindow).toMatch(/requirePerm\s*\(\s*['"]tickets['"]\s*,\s*['"]read['"]\s*\)/);
    expect(callWindow).toMatch(/requirePerm\s*\(\s*['"]tickets['"]\s*,\s*['"]write['"]\s*\)/);
  });

  it('removes the legacy ticketRepliesStore and /replies routes', () => {
    expect(appSrc).not.toContain('ticketRepliesStore');
    expect(ticketsRoutesSrc).not.toContain('ticketRepliesStore');
    expect(ticketsRoutesSrc).not.toContain("/replies");
  });
});
