/**
 * suricata-tickets-mirror (Phase F, task F.1, spec `suricata-tickets-ui`
 * UI-2..UI-5, design D13) — `GetSuricataTicketDetail` against InMemory ports.
 */
import { InMemorySuricataTicketRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataTicketRepository';
import { InMemorySuricataMessageRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataMessageRepository';
import { InMemorySuricataAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataAttachmentRepository';
import { InMemorySuricataVerdictRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataVerdictRepository';
import { InMemorySuricataAreaRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataAreaRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { GetSuricataTicketDetail } from '@application/use-cases/suricata/GetSuricataTicketDetail';
import { SuricataTicketNotFoundError } from '@domain/errors/suricata';

async function build() {
  const tickets = new InMemorySuricataTicketRepository();
  const messages = new InMemorySuricataMessageRepository();
  const attachments = new InMemorySuricataAttachmentRepository();
  const verdicts = new InMemorySuricataVerdictRepository();
  const areas = new InMemorySuricataAreaRepository();
  const users = new InMemoryRbacUserRepository();
  const useCase = new GetSuricataTicketDetail(tickets, messages, attachments, verdicts, areas, users);
  return { tickets, messages, attachments, verdicts, areas, users, useCase };
}

describe('GetSuricataTicketDetail', () => {
  it('unknown ticket -> SuricataTicketNotFoundError', async () => {
    const { useCase } = await build();
    await expect(useCase.execute('ghost')).rejects.toBeInstanceOf(SuricataTicketNotFoundError);
  });

  it('UI-2 — assembles ticket, ordered messages, attachments and verdict history exclusively from the mirror', async () => {
    const { tickets, messages, attachments, verdicts, areas, users, useCase } = await build();
    const [area] = await areas.upsertMany([{ externalId: 'a1', name: 'Facturación', syncedAt: '2026-09-01T00:00:00.000Z' }]);
    const agent = await users.create({ name: 'Beto', email: 'beto@x.com', login: 'beto', passwordHash: 'h', status: 'active' });

    const ticket = await tickets.upsertByExternalId({
      externalId: 'ext-1',
      subject: 'No tengo internet',
      status: 'abierto',
      priority: 'alta',
      areaId: area!.id,
      customerName: 'Juan',
      customerEmail: 'juan@x.com',
      customerPhone: '1122334455',
      externalClientRef: 'cli-9',
      clientId: null,
      openedAt: '2026-09-01T09:00:00.000Z',
      lastMessageAt: '2026-09-01T09:30:00.000Z',
      contentHash: 'hash-v1',
      syncedAt: '2026-09-01T09:30:00.000Z',
    });
    await tickets.setAssignee(ticket.id, agent.id);

    // Out of order on purpose — UI-3 requires the timeline rendered in order.
    await messages.upsertManyByExternalId(ticket.id, [
      { externalId: 'm-2', author: 'Juan', authorKind: 'customer', body: 'Sigue sin andar', sentAt: '2026-09-01T09:20:00.000Z' },
      { externalId: 'm-1', author: 'Juan', authorKind: 'customer', body: 'No tengo internet', sentAt: '2026-09-01T09:00:00.000Z' },
    ]);
    const msg1 = (await messages.listByTicketId(ticket.id)).find((m) => m.externalId === 'm-1')!;
    await attachments.upsertByExternalRef({ ticketId: ticket.id, messageId: msg1.id, externalRef: 'att-1', fileName: 'nota.mp3', mimeType: 'audio/mpeg' });

    await verdicts.create({ ticketId: ticket.id, resuelto: false, analisis: 'requiere revisión', motivo: 'sin señal', respuestaSugerida: 'enviar técnico', ticketContentHash: 'hash-v1', submittedBy: 'api-suricata' });

    const detail = await useCase.execute(ticket.id);

    expect(detail.id).toBe(ticket.id);
    expect(detail.areaName).toBe('Facturación');
    expect(detail.assigneeName).toBe('Beto');
    expect(detail.botState).toBe('requiere_humano');
    expect(detail.messages.map((m) => m.body)).toEqual(['No tengo internet', 'Sigue sin andar']);
    expect(detail.attachments).toHaveLength(1);
    expect(detail.attachments[0]?.fileName).toBe('nota.mp3');
    expect(detail.verdicts).toHaveLength(1);
    expect(detail.verdicts[0]?.stale).toBe(false);
  });

  it('UI-4 — ticket without any verdict reports botState sin_analizar and an empty verdict list', async () => {
    const { tickets, useCase } = await build();
    const ticket = await tickets.upsertByExternalId({
      externalId: 'ext-2',
      subject: 'Consulta',
      status: 'abierto',
      priority: null,
      areaId: null,
      customerName: null,
      customerEmail: null,
      customerPhone: null,
      externalClientRef: null,
      clientId: null,
      openedAt: null,
      lastMessageAt: null,
      contentHash: 'hash-v1',
      syncedAt: '2026-09-01T00:00:00.000Z',
    });

    const detail = await useCase.execute(ticket.id);
    expect(detail.botState).toBe('sin_analizar');
    expect(detail.verdicts).toHaveLength(0);
    expect(detail.areaName).toBeNull();
    expect(detail.assigneeName).toBeNull();
  });

  it('newest verdict first, and a stale verdict is flagged (D9)', async () => {
    const { tickets, verdicts, useCase } = await build();
    const ticket = await tickets.upsertByExternalId({
      externalId: 'ext-3',
      subject: 'x',
      status: 'abierto',
      priority: null,
      areaId: null,
      customerName: null,
      customerEmail: null,
      customerPhone: null,
      externalClientRef: null,
      clientId: null,
      openedAt: null,
      lastMessageAt: null,
      contentHash: 'hash-v2',
      syncedAt: '2026-09-01T00:00:00.000Z',
    });
    await verdicts.create({ ticketId: ticket.id, resuelto: true, analisis: 'v1', motivo: null, respuestaSugerida: null, ticketContentHash: 'hash-v1', submittedBy: 'api-suricata' });
    await new Promise((r) => setTimeout(r, 2));
    await verdicts.create({ ticketId: ticket.id, resuelto: true, analisis: 'v2', motivo: null, respuestaSugerida: null, ticketContentHash: 'hash-v1', submittedBy: 'api-suricata' });

    const detail = await useCase.execute(ticket.id);
    expect(detail.verdicts).toHaveLength(2);
    expect(detail.verdicts[0]?.analisis).toBe('v2');
    expect(detail.verdicts.every((v) => v.stale)).toBe(true);
    expect(detail.botState).toBe('stale');
  });
});
