import { RecaptureRepository } from '@domain/ports/RecaptureRepository';
import { RecaptureLeadNotFoundError, RecaptureLeadAlreadyClaimedError } from '@domain/errors/recapture';
import { RecaptureLeadDto, toRecaptureLeadDto } from '@application/dto/recapture/recapture.dto';

export class ClaimRecaptureLead {
  constructor(private readonly repo: RecaptureRepository) {}

  async execute(leadId: string, actorId: string): Promise<RecaptureLeadDto> {
    // Verify the lead exists first
    const existing = await this.repo.getById(leadId);
    if (!existing) throw new RecaptureLeadNotFoundError(leadId);

    // Atomic claim — returns null when already taken
    const lead = await this.repo.claim(leadId, actorId);
    if (!lead) throw new RecaptureLeadAlreadyClaimedError(leadId);

    return toRecaptureLeadDto(lead);
  }
}
