import type { SuricataTicketRepository } from '@domain/ports/SuricataTicketRepository';
import type { SuricataVerdictRepository } from '@domain/ports/SuricataVerdictRepository';
import { deriveSuricataBotState } from '@domain/entities/suricataBotState';
import type { SuricataKpisDto } from '@application/dto/suricata.dto';

function percentOf(count: number, total: number): number {
  if (total === 0) return 0;
  // 2 decimals — avoids floating-point noise without hiding the real ratio.
  return Math.round((count / total) * 10000) / 100;
}

/**
 * suricata-tickets-mirror (Phase F, task F.1, spec UI-6, design D9/D13) —
 * aggregate KPIs computed entirely from mirrored/verdict data, never a live
 * Suricata query. Percentages are computed over `total` tickets;
 * `staleCount` is reported separately and never folded into any percentage
 * (D9). Two queries total (all tickets + one batch verdict lookup) —
 * never N+1 regardless of how many tickets exist.
 */
export class ComputeSuricataKpis {
  constructor(
    private readonly tickets: SuricataTicketRepository,
    private readonly verdicts: SuricataVerdictRepository,
    private readonly opts: { now?: () => Date } = {},
  ) {}

  async execute(): Promise<SuricataKpisDto> {
    const rows = await this.tickets.list({});
    const verdictByTicketId = await this.verdicts.latestByTicketIds(rows.map((r) => r.id));

    const today = (this.opts.now?.() ?? new Date()).toISOString().slice(0, 10);

    let resueltoBotCount = 0;
    let requiereHumanoCount = 0;
    let sinVeredictoCount = 0;
    let staleCount = 0;
    let sincronizadosHoy = 0;

    for (const ticket of rows) {
      const botState = deriveSuricataBotState(ticket, verdictByTicketId.get(ticket.id) ?? null);
      switch (botState) {
        case 'sin_analizar':
          sinVeredictoCount++;
          break;
        case 'stale':
          staleCount++;
          break;
        case 'resuelto_bot':
          resueltoBotCount++;
          break;
        case 'requiere_humano':
          requiereHumanoCount++;
          break;
      }
      if (ticket.syncedAt.slice(0, 10) === today) sincronizadosHoy++;
    }

    const total = rows.length;
    return {
      total,
      resueltoBotPct: percentOf(resueltoBotCount, total),
      requiereHumanoPct: percentOf(requiereHumanoCount, total),
      sinVeredictoPct: percentOf(sinVeredictoCount, total),
      staleCount,
      sincronizadosHoy,
    };
  }
}
