import type { SuricataTicketRepository } from '@domain/ports/SuricataTicketRepository';
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { SuricataTicketRecord } from '@domain/entities/suricata';
import { SuricataTicketNotFoundError } from '@domain/errors/suricata';
import { UserNotFoundError } from '@domain/errors/rbacUser.errors';

export interface SetSuricataAssigneeInput {
  ticketId: string;
  assigneeId: string | null;
}

/**
 * suricata-tickets-mirror (Phase F, task F.1, spec UI-7) — Prominense-ONLY
 * assignment. This use case NEVER touches `SuricataScraperPort`,
 * `SuricataReplyPort`, or `SuricataSession` (D3.c) — it is a plain local
 * UPDATE against `SuricataTicketRepository`, nothing more. `assigneeId: null`
 * clears the assignment.
 */
export class SetSuricataAssignee {
  constructor(
    private readonly tickets: SuricataTicketRepository,
    private readonly users: RbacUserRepository,
  ) {}

  async execute(input: SetSuricataAssigneeInput): Promise<SuricataTicketRecord> {
    const ticket = await this.tickets.findById(input.ticketId);
    if (!ticket) throw new SuricataTicketNotFoundError(input.ticketId);

    if (input.assigneeId !== null) {
      const user = await this.users.findById(input.assigneeId);
      if (!user) throw new UserNotFoundError(input.assigneeId);
    }

    return this.tickets.setAssignee(ticket.id, input.assigneeId);
  }
}
