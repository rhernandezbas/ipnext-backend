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
const LIST_PAGE_HTML = `
  <select id="department">
    <option value="0">Seleccionar</option>
    <option value="1">Soporte</option>
    <option value="2">Ventas</option>
  </select>
  <script>let usuariologeado = '207';</script>
`;

function makeFakeBrowserSession(overrides: Partial<SuricataBrowserSession> = {}): SuricataBrowserSession {
  return {
    isAuthenticated: jest.fn().mockResolvedValue(true),
    login: jest.fn().mockResolvedValue(undefined),
    fetchHtml: jest.fn().mockResolvedValue(LIST_PAGE_HTML),
    fetchJson: jest.fn().mockResolvedValue({ tickets: [] }),
    fetchBinary: jest.fn().mockResolvedValue({ buffer: Buffer.from('x'), mimeType: 'image/png' }),
    ...overrides,
  };
}

describe('PlaywrightSuricataScraper', () => {
  const cfg = { baseUrl: 'https://suricata.example.com', sessionTimeoutMs: 5000 };

  it('listAreas fetches the tickets list page through the shared session and parses its department select', async () => {
    const browserSession = makeFakeBrowserSession();
    const session = new SuricataSession(browserSession, new InMemoryDistributedLock());
    const scraper = new PlaywrightSuricataScraper(session, cfg);

    const areas = await scraper.listAreas();

    expect(areas).toEqual([
      { externalId: '1', name: 'Soporte' },
      { externalId: '2', name: 'Ventas' },
    ]);
    expect(browserSession.fetchHtml).toHaveBeenCalledWith('https://suricata.example.com/ticketsdinamicosv2');
  });

  it('listTicketPage(1) reads the logged-in user id off the list page and calls the JSON API with it', async () => {
    const browserSession = makeFakeBrowserSession({
      fetchJson: jest.fn().mockResolvedValue({
        tickets: [
          {
            id: 18918,
            siennadepto: { texto: 'Soporte' },
            siennatopic: { texto: 'Sin Servicio' },
            prioridad: { texto: 'Normal' },
            siennaestado: { texto: 'Progreso' },
            fechadeconv: '2026-09-13 01:13:22',
          },
        ],
      }),
    });
    const session = new SuricataSession(browserSession, new InMemoryDistributedLock());
    const scraper = new PlaywrightSuricataScraper(session, cfg);

    const result = await scraper.listTicketPage(1);

    expect(browserSession.fetchJson).toHaveBeenCalledWith(
      'https://suricata.example.com/api/tickets-dinamicos?usuario=207',
    );
    expect(result).toEqual({
      hasNextPage: false,
      tickets: [
        {
          externalId: '18918',
          subject: 'Sin Servicio',
          status: 'Progreso',
          priority: 'Normal',
          areaExternalId: '1',
          lastMessageAt: '2026-09-13T01:13:22-03:00',
          messageCount: 0,
        },
      ],
    });
  });

  it('listTicketPage(2) never calls the JSON API again -- page 1 already returned everything', async () => {
    const browserSession = makeFakeBrowserSession();
    const session = new SuricataSession(browserSession, new InMemoryDistributedLock());
    const scraper = new PlaywrightSuricataScraper(session, cfg);

    const result = await scraper.listTicketPage(2);

    expect(result).toEqual({ tickets: [], hasNextPage: false });
    expect(browserSession.fetchJson).not.toHaveBeenCalled();
  });

  it('getTicket requests the detail page (?tick=) for that externalId', async () => {
    const browserSession = makeFakeBrowserSession({
      fetchHtml: jest
        .fn()
        .mockImplementation((url: string) =>
          Promise.resolve(url.includes('ticketunico') ? '<div id="ticketStatusName">Progreso</div>' : LIST_PAGE_HTML),
        ),
    });
    const session = new SuricataSession(browserSession, new InMemoryDistributedLock());
    const scraper = new PlaywrightSuricataScraper(session, cfg);

    const detail = await scraper.getTicket('1001');

    expect(browserSession.fetchHtml).toHaveBeenCalledWith('https://suricata.example.com/ticketunico?tick=1001');
    expect(detail.externalId).toBe('1001');
    expect(detail.status).toBe('Progreso');
    // sin config de Botpress en el fetchJson por defecto -> degrada a []
    expect(detail.messages).toEqual([]);
  });

  it('getTicket merges the last Botpress messages into the returned detail', async () => {
    const browserSession = makeFakeBrowserSession({
      fetchHtml: jest.fn().mockResolvedValue('<div id="ticketStatusName">Progreso</div>'),
      fetchJson: jest
        .fn()
        .mockImplementation((url: string) => {
          if (url.includes('metadata-merchant')) {
            return Promise.resolve({ settingsAll: [{ token_pa: 'bp_pat_x', bot_id: 'bot-1' }] });
          }
          if (url.includes('metadata-ticket')) {
            return Promise.resolve({ conversation_id: 'conv_1' });
          }
          if (url.includes('api.botpress.cloud')) {
            return Promise.resolve({
              messages: [
                { id: 'm1', createdAt: '2026-09-13T02:24:00.000Z', direction: 'incoming', payload: { text: 'hola' } },
              ],
            });
          }
          return Promise.resolve({ tickets: [] });
        }),
    });
    const session = new SuricataSession(browserSession, new InMemoryDistributedLock());
    const scraper = new PlaywrightSuricataScraper(session, cfg);

    const detail = await scraper.getTicket('1001');

    expect(detail.messages).toEqual([
      { externalId: 'm1', author: 'Cliente', authorKind: 'customer', body: 'hola', sentAt: '2026-09-13T02:24:00.000Z', attachments: [] },
    ]);
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
