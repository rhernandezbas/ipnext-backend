import { RecaptureRepository } from '@domain/ports/RecaptureRepository';
import { RecaptureLeadNotFoundError } from '@domain/errors/recapture';
import { RecaptureLeadDto, toRecaptureLeadDto } from '@application/dto/recapture/recapture.dto';

export class ReleaseRecaptureLead {
  constructor(private readonly repo: RecaptureRepository) {}

  async execute(leadId: string): Promise<RecaptureLeadDto> {
    const lead = await this.repo.release(leadId);
    if (!lead) throw new RecaptureLeadNotFoundError(leadId);
    return toRecaptureLeadDto(lead);
  }
}
