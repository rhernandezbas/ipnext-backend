/**
 * conversation-events (Ola 2) — GetResolutionsReport: eventos 'resolved' agrupados por día
 * calendario (zona AR), sólo dentro del rango, sólo días con count>0, orden ascendente.
 */
import { GetResolutionsReport } from '@application/use-cases/messaging/GetResolutionsReport';
import { InMemoryConversationEventRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationEventRepository';
import { MESSAGING_REPORTS_TIMEZONE } from '@application/dto/messagingReports';

const WIDE_FROM = '2020-01-01T00:00:00.000Z';
const WIDE_TO = '2100-01-01T00:00:00.000Z';

describe('GetResolutionsReport — conversation-events (Ola 2)', () => {
  it('agrupa "resolved" por día AR; ignora otros types y fuera de rango', async () => {
    const eventRepo = new InMemoryConversationEventRepository();
    const uc = new GetResolutionsReport(eventRepo);
    eventRepo.seed([
      { conversationId: 'c', type: 'resolved', createdAt: '2026-07-15T12:00:00.000Z' }, // AR 2026-07-15
      { conversationId: 'c', type: 'resolved', createdAt: '2026-07-15T18:00:00.000Z' }, // AR 2026-07-15
      { conversationId: 'c', type: 'resolved', createdAt: '2026-07-16T12:00:00.000Z' }, // AR 2026-07-16
      { conversationId: 'c', type: 'resolved', createdAt: '2026-07-15T01:30:00.000Z' }, // AR 2026-07-14 (roll-back)
      { conversationId: 'c', type: 'reopened', createdAt: '2026-07-15T12:00:00.000Z' }, // NO cuenta (otro type)
      { conversationId: 'c', type: 'resolved', createdAt: '2019-01-01T12:00:00.000Z' }, // NO cuenta (fuera de rango)
    ]);

    const result = await uc.execute(WIDE_FROM, WIDE_TO);

    expect(result.timezone).toBe(MESSAGING_REPORTS_TIMEZONE);
    expect(result.days).toEqual([
      { date: '2026-07-14', count: 1 },
      { date: '2026-07-15', count: 2 },
      { date: '2026-07-16', count: 1 },
    ]);
  });

  it('rango vacío → lista de días vacía', async () => {
    const eventRepo = new InMemoryConversationEventRepository();
    const uc = new GetResolutionsReport(eventRepo);
    eventRepo.seed([{ conversationId: 'c', type: 'resolved', createdAt: '2026-07-15T12:00:00.000Z' }]);

    const result = await uc.execute('2000-01-01T00:00:00.000Z', '2001-01-01T00:00:00.000Z');

    expect(result.days).toEqual([]);
  });
});
