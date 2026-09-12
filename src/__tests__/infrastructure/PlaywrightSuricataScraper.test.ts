import { SuricataSession } from '@infrastructure/adapters/suricata/SuricataSession';
import {
  PlaywrightSuricataScraper,
  type SuricataBrowserSession,
} from '@infrastructure/adapters/suricata/PlaywrightSuricataScraper';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';

/**
 * suricata-tickets-mirror (Phase C, task C.4, D0/D3/D4) — orchestration tests:
 * every port method acquires the shared session at 'low' priority and releases
 * it per call (D0: "suelta el mutex entre páginas"), never once for the whole
 * run. HTML parsing itself is covered by `suricata-selectors.test.ts`; this
 * suite only asserts the adapter wires session+URLs+parsing correctly.
 */
function makeFakeBrowserSession(overrides: Partial<SuricataBrowserSession> = {}): SuricataBrowserSession {
  return {
    isAuthenticated: jest.fn().mockResolvedValue(true),
    login: jest.fn().mockResolvedValue(undefined),
    fetchHtml: jest.fn().mockResolvedValue('<html></html>'),
    fetchBinary: jest.fn().mockResolvedValue({ buffer: Buffer.from('x'), mimeType: 'image/png' }),
    ...overrides,
  };
}

describe('PlaywrightSuricataScraper', () => {
  const cfg = { baseUrl: 'https://suricata.example.com', sessionTimeoutMs: 5000 };

  it('listAreas fetches the areas path through the shared session and parses it', async () => {
    const browserSession = makeFakeBrowserSession({
      fetchHtml: jest
        .fn()
        .mockResolvedValue(
          '<ul><li class="area-row" data-area-id="a-1">Soporte</li></ul>',
        ),
    });
    const session = new SuricataSession(browserSession, new InMemoryDistributedLock());
    const scraper = new PlaywrightSuricataScraper(session, cfg);

    const areas = await scraper.listAreas();

    expect(areas).toEqual([{ externalId: 'a-1', name: 'Soporte' }]);
    expect(browserSession.fetchHtml).toHaveBeenCalledWith('https://suricata.example.com/areas');
  });

  it('listTicketPage requests the given page number', async () => {
    const browserSession = makeFakeBrowserSession();
    const session = new SuricataSession(browserSession, new InMemoryDistributedLock());
    const scraper = new PlaywrightSuricataScraper(session, cfg);

    await scraper.listTicketPage(3);

    expect(browserSession.fetchHtml).toHaveBeenCalledWith('https://suricata.example.com/tickets?page=3');
  });

  it('getTicket requests the detail page for that externalId', async () => {
    const browserSession = makeFakeBrowserSession();
    const session = new SuricataSession(browserSession, new InMemoryDistributedLock());
    const scraper = new PlaywrightSuricataScraper(session, cfg);

    await scraper.getTicket('1001');

    expect(browserSession.fetchHtml).toHaveBeenCalledWith('https://suricata.example.com/tickets/1001');
  });

  it('fetchAttachment resolves a relative ref against baseUrl and returns the fetched bytes', async () => {
    const browserSession = makeFakeBrowserSession({
      fetchBinary: jest.fn().mockResolvedValue({ buffer: Buffer.from('IMG'), mimeType: 'image/png' }),
    });
    const session = new SuricataSession(browserSession, new InMemoryDistributedLock());
    const scraper = new PlaywrightSuricataScraper(session, cfg);

    const result = await scraper.fetchAttachment('/attachments/att-1.png');

    expect(browserSession.fetchBinary).toHaveBeenCalledWith('https://suricata.example.com/attachments/att-1.png');
    expect(result).toEqual({ buffer: Buffer.from('IMG'), mimeType: 'image/png', fileName: 'att-1.png' });
  });

  it('D0 — each call acquires and releases the session independently (never once for the whole run)', async () => {
    const browserSession = makeFakeBrowserSession();
    const lock = new InMemoryDistributedLock();
    const session = new SuricataSession(browserSession, lock);
    const scraper = new PlaywrightSuricataScraper(session, cfg);

    await scraper.listTicketPage(1);
    expect(lock.heldKeys.size).toBe(0); // released after page 1
    await scraper.listTicketPage(2);
    expect(lock.heldKeys.size).toBe(0); // released after page 2 too
  });
});
