/**
 * suricata-tickets-mirror (Phase F, task F.1, spec `suricata-tickets-ui`
 * UI-6, design D9/D13) — `ComputeSuricataKpis` against InMemory ports.
 * Percentages are computed BY HAND in this test (repo convention, D12).
 */
import { InMemorySuricataTicketRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataTicketRepository';
import { InMemorySuricataVerdictRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataVerdictRepository';
import { ComputeSuricataKpis } from '@application/use-cases/suricata/ComputeSuricataKpis';

async function mkTicket(tickets: InMemorySuricataTicketRepository, externalId: string, syncedAt: string, contentHash = 'hash-v1') {
  return tickets.upsertByExternalId({
    externalId,
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
    contentHash,
    syncedAt,
  });
}

describe('ComputeSuricataKpis', () => {
  it('UI-6 — total=0 never divides by zero', async () => {
    const tickets = new InMemorySuricataTicketRepository();
    const verdicts = new InMemorySuricataVerdictRepository();
    const useCase = new ComputeSuricataKpis(tickets, verdicts);

    const kpis = await useCase.execute();
    expect(kpis).toEqual({ total: 0, resueltoBotPct: 0, requiereHumanoPct: 0, sinVeredictoPct: 0, staleCount: 0, sincronizadosHoy: 0 });
  });

  it('UI-6 — hand-computed percentages over a 5-ticket mix, plus stale reported separately and never folded in', async () => {
    const tickets = new InMemorySuricataTicketRepository();
    const verdicts = new InMemorySuricataVerdictRepository();
    const now = () => new Date('2026-09-12T12:00:00.000Z');
    const useCase = new ComputeSuricataKpis(tickets, verdicts, { now });

    // 5 tickets total:
    //   t1 — no verdict                          -> sin_analizar
    //   t2 — resuelto:true, fresh                -> resuelto_bot
    //   t3 — resuelto:true, fresh                -> resuelto_bot
    //   t4 — resuelto:false, fresh               -> requiere_humano
    //   t5 — verdict exists but hash mismatch    -> stale
    // Hand math: total=5, resueltoBotPct=2/5*100=40, requiereHumanoPct=1/5*100=20,
    // sinVeredictoPct=1/5*100=20, staleCount=1 (NOT part of any percentage).
    const t1 = await mkTicket(tickets, 'e1', '2026-09-11T08:00:00.000Z');
    const t2 = await mkTicket(tickets, 'e2', '2026-09-12T08:00:00.000Z'); // synced TODAY
    const t3 = await mkTicket(tickets, 'e3', '2026-09-12T09:00:00.000Z'); // synced TODAY
    const t4 = await mkTicket(tickets, 'e4', '2026-09-11T08:00:00.000Z');
    const t5 = await mkTicket(tickets, 'e5', '2026-09-11T08:00:00.000Z', 'hash-v2');
    void t1;

    await verdicts.create({ ticketId: t2.id, resuelto: true, analisis: 'ok', motivo: null, respuestaSugerida: null, ticketContentHash: 'hash-v1', submittedBy: 'api-suricata' });
    await verdicts.create({ ticketId: t3.id, resuelto: true, analisis: 'ok', motivo: null, respuestaSugerida: null, ticketContentHash: 'hash-v1', submittedBy: 'api-suricata' });
    await verdicts.create({ ticketId: t4.id, resuelto: false, analisis: 'no', motivo: 'm', respuestaSugerida: 'r', ticketContentHash: 'hash-v1', submittedBy: 'api-suricata' });
    await verdicts.create({ ticketId: t5.id, resuelto: true, analisis: 'viejo', motivo: null, respuestaSugerida: null, ticketContentHash: 'hash-v1', submittedBy: 'api-suricata' });

    const kpis = await useCase.execute();

    expect(kpis.total).toBe(5);
    expect(kpis.resueltoBotPct).toBe(40);
    expect(kpis.requiereHumanoPct).toBe(20);
    expect(kpis.sinVeredictoPct).toBe(20);
    expect(kpis.staleCount).toBe(1);
    // 40 + 20 + 20 = 80, NOT 100 — the stale ticket is deliberately excluded
    // from all three percentages (D9), never mixed in.
    expect(kpis.resueltoBotPct + kpis.requiereHumanoPct + kpis.sinVeredictoPct).toBe(80);
    expect(kpis.sincronizadosHoy).toBe(2);
  });

  it('UI-6 scenario — a ticket moving from no-verdict to resuelto:true increases resueltoBotPct and decreases sinVeredictoPct', async () => {
    const tickets = new InMemorySuricataTicketRepository();
    const verdicts = new InMemorySuricataVerdictRepository();
    const useCase = new ComputeSuricataKpis(tickets, verdicts);

    const ticket = await mkTicket(tickets, 'e1', '2026-09-01T00:00:00.000Z');
    const before = await useCase.execute();
    expect(before.sinVeredictoPct).toBe(100);
    expect(before.resueltoBotPct).toBe(0);

    await verdicts.create({ ticketId: ticket.id, resuelto: true, analisis: 'ok', motivo: null, respuestaSugerida: null, ticketContentHash: 'hash-v1', submittedBy: 'api-suricata' });
    const after = await useCase.execute();
    expect(after.resueltoBotPct).toBe(100);
    expect(after.sinVeredictoPct).toBe(0);
  });
});
