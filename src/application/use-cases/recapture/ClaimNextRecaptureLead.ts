import { RecaptureRepository } from '@domain/ports/RecaptureRepository';
import { RecaptureLeadDto, toRecaptureLeadDto } from '@application/dto/recapture/recapture.dto';

export class ClaimNextRecaptureLead {
  constructor(private readonly repo: RecaptureRepository) {}

  /**
   * Claims the oldest free (status='nuevo', unassigned) lead for `actorId`.
   * Returns the lead DTO, or null if no free leads are available.
   */
  async execute(actorId: string): Promise<RecaptureLeadDto | null> {
    const lead = await this.repo.claimNext(actorId);
    if (!lead) return null;
    return toRecaptureLeadDto(lead);
  }
}
