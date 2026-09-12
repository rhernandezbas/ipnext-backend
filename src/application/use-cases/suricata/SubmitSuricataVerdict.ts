import type { SuricataTicketRepository } from '@domain/ports/SuricataTicketRepository';
import type { SuricataVerdictRepository } from '@domain/ports/SuricataVerdictRepository';
import { InvalidSuricataVerdictError, SuricataTicketNotFoundError } from '@domain/errors/suricata';
import { API_SURICATA_USER_LOGIN } from '@domain/constants/machineUsers';

export interface SubmitSuricataVerdictInput {
  ticketExternalId: string;
  resuelto: boolean;
  analisis: string;
  motivo?: string;
  respuestaSugerida?: string;
}

export interface SubmitSuricataVerdictResult {
  verdictId: string;
  ticketExternalId: string;
  createdAt: string;
}

/**
 * suricata-tickets-mirror (Phase D, task D.2, spec suricata-bot-verdict
 * VERDICT-2..5, design D9) — validates the conditional business rule
 * (`resuelto=false` requires `motivo`+`respuestaSugerida`, VERDICT-2), checks
 * the ticket exists in the mirror (VERDICT-3), then appends a NEW verdict row
 * (VERDICT-4, never an update). `submittedBy` is a plain login string
 * (`api-suricata`) — the field is NOT a FK (schema `String`, not
 * `RbacUser.id`), so no `RbacUserRepository` round-trip is needed here.
 */
export class SubmitSuricataVerdict {
  constructor(
    private readonly tickets: SuricataTicketRepository,
    private readonly verdicts: SuricataVerdictRepository,
    private readonly submittedBy: string = API_SURICATA_USER_LOGIN,
  ) {}

  async execute(input: SubmitSuricataVerdictInput): Promise<SubmitSuricataVerdictResult> {
    if (!input.resuelto) {
      const missingFields: string[] = [];
      if (!input.motivo || input.motivo.trim() === '') missingFields.push('motivo');
      if (!input.respuestaSugerida || input.respuestaSugerida.trim() === '') missingFields.push('respuestaSugerida');
      if (missingFields.length > 0) throw new InvalidSuricataVerdictError(missingFields);
    }

    const ticket = await this.tickets.findByExternalId(input.ticketExternalId);
    if (!ticket) throw new SuricataTicketNotFoundError(input.ticketExternalId);

    const created = await this.verdicts.create({
      ticketId: ticket.id,
      resuelto: input.resuelto,
      analisis: input.analisis,
      motivo: input.resuelto ? null : (input.motivo as string),
      respuestaSugerida: input.resuelto ? null : (input.respuestaSugerida as string),
      ticketContentHash: ticket.contentHash,
      submittedBy: this.submittedBy,
    });

    return {
      verdictId: created.id,
      ticketExternalId: input.ticketExternalId,
      createdAt: created.createdAt,
    };
  }
}
