import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parseSuricataAreaList,
  parseSuricataTicketListPage,
  parseSuricataTicketDetail,
} from '@infrastructure/adapters/suricata/selectors';

/**
 * suricata-tickets-mirror (Phase C, task C.3/C.4, D6.d) — pure HTML parsers, no
 * network. DEVIATION (flagged in the apply report): these fixtures are
 * HAND-AUTHORED to match a plausible Suricata Cx tickets UI, not captured from
 * the live system — this apply session has no Suricata credentials/network
 * access. `PlaywrightSuricataScraper`'s selectors will need re-verification
 * against the real DOM before `SURICATA_BROWSER_WS` is ever set in prod (D14
 * step 3/4 manual smoke already gates that).
 */
const FIX = join(__dirname, 'fixtures', 'suricata');
const load = (name: string) => readFileSync(join(FIX, name), 'utf8');

describe('parseSuricataAreaList', () => {
  it('extracts every area row', () => {
    const areas = parseSuricataAreaList(load('area-list.html'));
    expect(areas).toEqual([
      { externalId: 'area-1', name: 'Soporte Técnico' },
      { externalId: 'area-2', name: 'Facturación' },
      { externalId: 'area-3', name: 'Ventas' },
    ]);
  });
});

describe('parseSuricataTicketListPage', () => {
  it('extracts every ticket row and detects a next page', () => {
    const page = parseSuricataTicketListPage(load('ticket-list.html'));
    expect(page.hasNextPage).toBe(true);
    expect(page.tickets).toEqual([
      {
        externalId: '1001',
        subject: 'No tengo internet',
        status: 'abierto',
        priority: 'alta',
        areaExternalId: 'area-1',
        lastMessageAt: '2026-09-01T10:00:00.000Z',
        messageCount: 3,
      },
      {
        externalId: '1002',
        subject: 'Consulta de factura',
        status: 'cerrado',
        priority: 'baja',
        areaExternalId: 'area-2',
        lastMessageAt: '2026-08-30T15:30:00.000Z',
        messageCount: 1,
      },
    ]);
  });

  it('a legitimately empty list -> zero tickets, no next page, does not throw', () => {
    const page = parseSuricataTicketListPage(load('ticket-list-empty.html'));
    expect(page.tickets).toEqual([]);
    expect(page.hasNextPage).toBe(false);
  });

  it('D6.d — a redesigned/broken DOM also degrades to zero tickets without throwing', () => {
    // Structurally indistinguishable from a legitimate empty page at the parser
    // level -- MIRROR-5/D6.d's invariant 1 (page 1 must yield >=1 ticket on a
    // 200 response) is the USE CASE's job, not the parser's.
    const page = parseSuricataTicketListPage(load('ticket-list-dom-changed.html'));
    expect(page.tickets).toEqual([]);
    expect(page.hasNextPage).toBe(false);
  });
});

describe('parseSuricataTicketDetail', () => {
  it('extracts ticket fields, messages and inline attachments', () => {
    const detail = parseSuricataTicketDetail(load('ticket-detail-with-attachment.html'));
    expect(detail.externalId).toBe('1001');
    expect(detail.subject).toBe('No tengo internet');
    expect(detail.status).toBe('abierto');
    expect(detail.priority).toBe('alta');
    expect(detail.areaExternalId).toBe('area-1');
    expect(detail.customerName).toBe('Juan Perez');
    expect(detail.customerEmail).toBe('juan@example.com');
    expect(detail.customerPhone).toBe('+5491122334455');
    expect(detail.externalClientRef).toBe('CLI-9090');
    expect(detail.openedAt).toBe('2026-08-01T09:00:00.000Z');
    expect(detail.lastMessageAt).toBe('2026-09-01T10:00:00.000Z');
    expect(detail.messages).toHaveLength(2);

    const [first, second] = detail.messages;
    expect(first).toMatchObject({
      externalId: 'm-1',
      author: 'Juan Perez',
      authorKind: 'customer',
      sentAt: '2026-09-01T09:55:00.000Z',
      body: 'No tengo internet desde ayer',
    });
    expect(first.attachments).toEqual([]);

    expect(second.attachments).toEqual([
      {
        externalRef: '/attachments/att-1.png',
        fileName: 'captura.png',
        mimeType: 'image/png',
        sizeBytes: 20480,
      },
    ]);
  });
});
