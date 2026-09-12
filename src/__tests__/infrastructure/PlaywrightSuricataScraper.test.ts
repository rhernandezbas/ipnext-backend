import { SuricataSession } from '@infrastructure/adapters/suricata/SuricataSession';
import {
  PlaywrightSuricataScraper,
  type SuricataBrowserSession,
} from '@infrastructure/adapters/suricata/PlaywrightSuricataScraper';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';
import { SuricataAttachmentInvalidOriginError } from '@domain/errors/suricata';

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

  describe('SSRF guard — the attachment href comes from a THIRD-PARTY DOM', () => {
    // `new URL(ref, baseUrl)` IGNORES the base when `ref` is absolute, so a
    // poisoned/compromised Suricata page could aim the sidecar (which sits on
    // the internal `ipnext-net`) at any host it likes, and the response would
    // be persisted and later served by us.
    const hostile = [
      ['another public host', 'https://evil.example.com/payload.png'],
      ['an internal service', 'http://minio:9000/ipnext/secrets.json'],
      ['the cloud metadata endpoint', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/'],
      ['a different port on the same host', 'https://suricata.example.com:8443/att.png'],
      ['a different scheme on the same host', 'http://suricata.example.com/att.png'],
      ['a file:// ref', 'file:///etc/passwd'],
      ['a protocol-relative ref', '//evil.example.com/payload.png'],
    ] as const;

    it.each(hostile)('rejects %s without ever calling fetchBinary', async (_label, ref) => {
      const browserSession = makeFakeBrowserSession();
      const session = new SuricataSession(browserSession, new InMemoryDistributedLock());
      const scraper = new PlaywrightSuricataScraper(session, cfg);

      await expect(scraper.fetchAttachment(ref)).rejects.toThrow(SuricataAttachmentInvalidOriginError);
      expect(browserSession.fetchBinary).not.toHaveBeenCalled();
    });

    it('the thrown error message is exactly `invalid_origin`, so the sync marks the row failed/invalid_origin', async () => {
      const browserSession = makeFakeBrowserSession();
      const session = new SuricataSession(browserSession, new InMemoryDistributedLock());
      const scraper = new PlaywrightSuricataScraper(session, cfg);

      let thrown: unknown;
      try {
        await scraper.fetchAttachment('http://169.254.169.254/latest/meta-data/');
      } catch (err) {
        thrown = err;
      }

      expect((thrown as Error).message).toBe('invalid_origin');
    });

    it('still accepts a same-origin ABSOLUTE ref (not everything absolute is hostile)', async () => {
      const browserSession = makeFakeBrowserSession({
        fetchBinary: jest.fn().mockResolvedValue({ buffer: Buffer.from('IMG'), mimeType: 'image/png' }),
      });
      const session = new SuricataSession(browserSession, new InMemoryDistributedLock());
      const scraper = new PlaywrightSuricataScraper(session, cfg);

      await scraper.fetchAttachment('https://suricata.example.com/attachments/att-9.png');

      expect(browserSession.fetchBinary).toHaveBeenCalledWith('https://suricata.example.com/attachments/att-9.png');
    });
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
