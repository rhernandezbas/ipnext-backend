import { RecaptureRepository } from '@domain/ports/RecaptureRepository';
import { RecaptureLeadStatus } from '@domain/entities/recaptureLead';
import { RecaptureLeadNotFoundError } from '@domain/errors/recapture';
import { RecaptureLeadDto, toRecaptureLeadDto } from '@application/dto/recapture/recapture.dto';

export class UpdateRecaptureLeadStatus {
  constructor(private readonly repo: RecaptureRepository) {}

  async execute(leadId: string, status: RecaptureLeadStatus): Promise<RecaptureLeadDto> {
    const lead = await this.repo.updateStatus(leadId, status);
    if (!lead) throw new RecaptureLeadNotFoundError(leadId);
    return toRecaptureLeadDto(lead);
  }
}
