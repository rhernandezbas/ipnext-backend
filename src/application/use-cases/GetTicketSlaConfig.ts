import { TicketSlaConfigRepository } from '@domain/ports/TicketSlaConfigRepository';
import { TicketSlaConfigDto, toTicketSlaConfigDto } from '@application/dto/tickets.dto';

/**
 * #79 — Returns the current ticket SLA timer config as a DTO.
 * The repo returns defaults (warn 60 / danger 240) when no row exists yet.
 */
export class GetTicketSlaConfig {
  constructor(private readonly config: TicketSlaConfigRepository) {}

  async execute(): Promise<TicketSlaConfigDto> {
    return toTicketSlaConfigDto(await this.config.get());
  }
}
