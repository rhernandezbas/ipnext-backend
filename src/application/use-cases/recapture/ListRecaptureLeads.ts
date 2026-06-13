import { RecaptureRepository, ListRecaptureLeadsQuery } from '@domain/ports/RecaptureRepository';
import { PaginatedResult } from '@application/dto/pagination';
import { RecaptureLeadDto, toRecaptureLeadDto } from '@application/dto/recapture/recapture.dto';

export class ListRecaptureLeads {
  constructor(private readonly repo: RecaptureRepository) {}

  async execute(query: ListRecaptureLeadsQuery): Promise<PaginatedResult<RecaptureLeadDto>> {
    const result = await this.repo.list(query);
    return {
      ...result,
      data: result.data.map(toRecaptureLeadDto),
    };
  }
}
