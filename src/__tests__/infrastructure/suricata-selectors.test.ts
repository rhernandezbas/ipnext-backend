import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parseSuricataAreaOptions,
  extractLoggedInUserId,
  parseSuricataTicketsDinamicos,
  parseSuricataTicketDetail,
  type SuricataTicketsDinamicosResponse,
} from '@infrastructure/adapters/suricata/selectors';

/**
 * suricata-tickets-mirror -- these fixtures were RE-CAPTURED live (Playwright
 * MCP, authenticated) against `ipnext.suricata.cloud` on 2026-09-13, replacing
 * the original hand-authored ones (flagged as a DEVIATION in the apply
 * report) that turned out to not match the real DOM/API at all.
 */
const FIX = join(__dirname, 'fixtures', 'suricata');
const load = (name: string) => readFileSync(join(FIX, name), 'utf8');

describe('parseSuricataAreaOptions', () => {
  it('extracts every real option from the department select, skipping the placeholder', () => {
    const areas = parseSuricataAreaOptions(load('tickets-list-page.html'));
    expect(areas).toEqual([
      { externalId: '1', name: 'Soporte' },
      { externalId: '2', name: 'Administración' },
      { externalId: '3', name: 'Ventas' },
      { externalId: '4', name: 'GR' },
    ]);
  });
});

describe('extractLoggedInUserId', () => {
  it('reads the numeric id off the inline bootstrap script', () => {
    expect(extractLoggedInUserId(load('tickets-list-page.html'))).toBe('207');
  });

  it('returns null when the marker is absent', () => {
    expect(extractLoggedInUserId('<html></html>')).toBeNull();
  });
});

describe('parseSuricataTicketsDinamicos', () => {
  const areaNameToId = new Map([
    ['Soporte', '1'],
    ['Ventas', '3'],
  ]);

  it('maps every ticket, resolves the area name to its id, and sorts by activity descending', () => {
    const json = JSON.parse(load('tickets-dinamicos.json')) as SuricataTicketsDinamicosResponse;
    const page = parseSuricataTicketsDinamicos(json, areaNameToId);

    expect(page.hasNextPage).toBe(false);
    expect(page.tickets.map((t) => t.externalId)).toEqual(['18918', '18879']); // newest fechadeconv first
    expect(page.tickets[0]).toEqual({
      externalId: '18918',
      subject: 'Sin Servicio',
      status: 'Progreso',
      priority: 'Normal',
      areaExternalId: '1',
      lastMessageAt: '2026-09-13 01:13:22',
      messageCount: 0,
    });
  });

  it('an area name with no match in the catalog resolves to null instead of throwing', () => {
    const page = parseSuricataTicketsDinamicos(
      { tickets: [{ id: 1, siennadepto: { texto: 'Departamento Nuevo' }, fechadeconv: '2026-01-01 00:00:00' }] },
      areaNameToId,
    );
    expect(page.tickets[0]?.areaExternalId).toBeNull();
  });

  it('a legitimately empty response -> zero tickets, no next page, does not throw', () => {
    const page = parseSuricataTicketsDinamicos({ tickets: [] }, areaNameToId);
    expect(page.tickets).toEqual([]);
    expect(page.hasNextPage).toBe(false);
  });
});

describe('parseSuricataTicketDetail', () => {
  const areaNameToId = new Map([['Soporte', '1']]);

  it('extracts ticket fields and the customer info panel from the real detail page shape', () => {
    const detail = parseSuricataTicketDetail(load('ticket-detail.html'), '18918', areaNameToId);

    expect(detail.externalId).toBe('18918');
    expect(detail.subject).toBe('Sin Servicio');
    expect(detail.status).toBe('Progreso');
    expect(detail.priority).toBe('Normal');
    expect(detail.areaExternalId).toBe('1');
    expect(detail.customerName).toBe('ENLEIF DIEGO FERNANDO');
    expect(detail.customerEmail).toBe('diegoenle@gmail.com');
    expect(detail.customerPhone).toBe('5491169739923');
    expect(detail.externalClientRef).toBe('108399');
    expect(detail.openedAt).toBe('2026-09-12 20:38:52');
    // Not scrapeable from this page -- the caller falls back to the list
    // summary's lastMessageAt (SyncSuricataTickets).
    expect(detail.lastMessageAt).toBeNull();
  });

  it('the conversation thread is never scraped from this page -- it lives in a cross-origin iframe', () => {
    const detail = parseSuricataTicketDetail(load('ticket-detail.html'), '18918', areaNameToId);
    expect(detail.messages).toEqual([]);
  });
});
