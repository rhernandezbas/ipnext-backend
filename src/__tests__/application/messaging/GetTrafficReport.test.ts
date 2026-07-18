/**
 * conversation-events (Ola 2) — GetTrafficReport: mensajes INBOUND agrupados por día×hora
 * en zona AR, sólo dentro del rango [from,to), sólo celdas con count>0.
 */
import { GetTrafficReport } from '@application/use-cases/messaging/GetTrafficReport';
import { InMemoryChatMessageRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageRepository';
import { MESSAGING_REPORTS_TIMEZONE } from '@application/dto/messagingReports';

const WIDE_FROM = '2020-01-01T00:00:00.000Z';
const WIDE_TO = '2100-01-01T00:00:00.000Z';

let seq = 0;
async function seedInbound(repo: InMemoryChatMessageRepository, chatwootCreatedAt: string, direction: 'inbound' | 'outbound' = 'inbound') {
  await repo.upsertByChatwootMessageId({
    conversationId: 'conv-x',
    chatwootMessageId: ++seq,
    direction,
    content: 'x',
    chatwootCreatedAt,
  });
}

describe('GetTrafficReport — conversation-events (Ola 2)', () => {
  it('agrupa inbound por dow×hour en zona AR, ignora outbound y fuera de rango', async () => {
    const repo = new InMemoryChatMessageRepository();
    const uc = new GetTrafficReport(repo);
    await seedInbound(repo, '2026-07-15T12:00:00.000Z'); // AR miércoles 09h → {3,9}
    await seedInbound(repo, '2026-07-15T12:30:00.000Z'); // AR miércoles 09h → {3,9} (misma celda)
    await seedInbound(repo, '2026-07-15T01:30:00.000Z'); // AR martes 22h → {2,22}
    await seedInbound(repo, '2026-07-15T12:00:00.000Z', 'outbound'); // NO cuenta (outbound)
    await seedInbound(repo, '2019-01-01T12:00:00.000Z'); // NO cuenta (fuera de rango)

    const result = await uc.execute(WIDE_FROM, WIDE_TO);

    expect(result.timezone).toBe(MESSAGING_REPORTS_TIMEZONE);
    expect(result.cells).toEqual([
      { dow: 2, hour: 22, count: 1 },
      { dow: 3, hour: 9, count: 2 },
    ]);
  });

  it('rango vacío → lista de celdas vacía', async () => {
    const repo = new InMemoryChatMessageRepository();
    const uc = new GetTrafficReport(repo);
    await seedInbound(repo, '2026-07-15T12:00:00.000Z');

    const result = await uc.execute('2000-01-01T00:00:00.000Z', '2001-01-01T00:00:00.000Z');

    expect(result.cells).toEqual([]);
  });
});
