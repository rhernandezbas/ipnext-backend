import { TicketSlaConfigRepository } from '@domain/ports/TicketSlaConfigRepository';
import {
  TicketSlaConfigDto,
  UpdateTicketSlaConfigInput,
  toTicketSlaConfigDto,
} from '@application/dto/tickets.dto';
import { TicketSlaThresholdOrderError } from '@domain/errors/tickets';

/**
 * #79 — Applies a validated partial patch to the ticket SLA timer config.
 *
 * Shape validation (positive integers) is the route's job via the Zod schema.
 * The cross-field invariant `dangerMinutes > warnMinutes` lives HERE because it
 * must run against the MERGED config: a partial body (e.g. only `warnMinutes`)
 * can't see the other side, so we read the current config, merge the patch, and
 * validate the result before persisting. On violation, nothing is written.
 */
export class UpdateTicketSlaConfig {
  constructor(private readonly config: TicketSlaConfigRepository) {}

  async execute(patch: UpdateTicketSlaConfigInput): Promise<TicketSlaConfigDto> {
    const current = await this.config.get();
    const merged = {
      warnMinutes: patch.warnMinutes ?? current.warnMinutes,
      dangerMinutes: patch.dangerMinutes ?? current.dangerMinutes,
    };
    if (merged.dangerMinutes <= merged.warnMinutes) {
      throw new TicketSlaThresholdOrderError(merged.warnMinutes, merged.dangerMinutes);
    }
    return toTicketSlaConfigDto(await this.config.update(patch));
  }
}
