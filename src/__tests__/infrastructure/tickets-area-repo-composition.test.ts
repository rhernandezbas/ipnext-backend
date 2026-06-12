/**
 * #49 — composition-root static guard.
 *
 * Booting createApp() needs a live DB, so this asserts the wiring statically by
 * reading app.ts source (same pattern as tickets-status-repo-composition.test.ts).
 *
 * The obligatoriedad del área en POST /tickets is enforced inside the tickets
 * router ONLY when it receives a ticketAreaRepo (the param is optional in the
 * router signature — `if (areaRepo)`). If a future wiring change drops the repo
 * from the createTicketsRouter() call, area validation would silently turn off.
 * This pins that app.ts keeps passing ticketAreaRepo into the tickets router.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Tickets ticketAreaRepo composition root (#49)', () => {
  let appSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'),
      'utf8',
    );
  });

  it('instantiates PrismaTicketAreaCatalogRepository exactly once', () => {
    const occurrences = appSrc.match(/new PrismaTicketAreaCatalogRepository\(/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it('assigns the single instance to a ticketAreaRepo binding', () => {
    expect(appSrc).toMatch(/const\s+ticketAreaRepo\s*=\s*new PrismaTicketAreaCatalogRepository\(/);
  });

  it('passes ticketAreaRepo into createTicketsRouter(', () => {
    const callIdx = appSrc.indexOf('createTicketsRouter(');
    expect(callIdx).toBeGreaterThan(-1);
    // The router takes many positional deps; widen the window to span the full call.
    const callWindow = appSrc.slice(callIdx, callIdx + 800);
    expect(callWindow).toContain('ticketAreaRepo');
  });
});
