import { RecaptureRepository } from '@domain/ports/RecaptureRepository';
import { RecaptureLeadNotFoundError } from '@domain/errors/recapture';
import { RecaptureLeadDetailDto, toRecaptureLeadDetailDto } from '@application/dto/recapture/recapture.dto';

export class GetRecaptureLead {
  constructor(private readonly repo: RecaptureRepository) {}

  async execute(id: string): Promise<RecaptureLeadDetailDto> {
    const lead = await this.repo.getById(id);
    if (!lead) throw new RecaptureLeadNotFoundError(id);
    return toRecaptureLeadDetailDto(lead);
  }
}
