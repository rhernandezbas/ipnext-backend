/**
 * #46 — composition-root static guard.
 *
 * Booting createApp() needs a live DB, so this asserts the wiring statically by
 * reading app.ts source (same pattern as projects-network-flag-composition.test.ts).
 *
 * CloseTicket (#46 M1) resolves the closed-like catalog name via the ticketStatus
 * repo instead of hardcoding 'closed'. The SAME repo instance must back both
 * CloseTicket and the tickets router's status-catalog use cases — instantiating it
 * twice would let the two views of the catalog drift. This pins:
 *
 *  1) ticketStatusRepo is instantiated EXACTLY ONCE (single `new PrismaTicketStatusRepository()`).
 *  2) That instance is passed to BOTH `new CloseTicket(` and `createTicketsRouter(`.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Tickets ticketStatusRepo composition root (#46)', () => {
  let appSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'),
      'utf8',
    );
  });

  it('instantiates PrismaTicketStatusRepository exactly once', () => {
    const occurrences = appSrc.match(/new PrismaTicketStatusRepository\(/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it('assigns the single instance to a ticketStatusRepo binding', () => {
    expect(appSrc).toMatch(/const\s+ticketStatusRepo\s*=\s*new PrismaTicketStatusRepository\(/);
  });

  it('passes ticketStatusRepo into new CloseTicket(', () => {
    const match = appSrc.match(/new CloseTicket\(([\s\S]*?)\)\s*;/);
    expect(match).not.toBeNull();
    expect(match![1]).toContain('ticketStatusRepo');
  });

  it('passes ticketStatusRepo into createTicketsRouter(', () => {
    const callIdx = appSrc.indexOf('createTicketsRouter(');
    expect(callIdx).toBeGreaterThan(-1);
    const callWindow = appSrc.slice(callIdx, callIdx + 600);
    expect(callWindow).toContain('ticketStatusRepo');
  });
});
