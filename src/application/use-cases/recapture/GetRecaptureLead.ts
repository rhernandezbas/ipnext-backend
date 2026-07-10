import { RecaptureRepository } from '@domain/ports/RecaptureRepository';
import { CustomerRepository } from '@domain/ports/CustomerRepository';
import { RecaptureLeadNotFoundError } from '@domain/errors/recapture';
import {
  RecaptureLeadDetailDto,
  PossibleActiveMatch,
  toRecaptureLeadDetailDto,
} from '@application/dto/recapture/recapture.dto';
import { matchActiveClient } from '@application/use-cases/recapture/matchActiveClient';

const EMPTY_MATCH: PossibleActiveMatch = { signals: [], matchedClients: [] };

export class GetRecaptureLead {
  constructor(
    private readonly repo: RecaptureRepository,
    private readonly customerRepo: CustomerRepository,
  ) {}

  async execute(id: string): Promise<RecaptureLeadDetailDto> {
    const lead = await this.repo.getById(id);
    if (!lead) throw new RecaptureLeadNotFoundError(id);

    // Fail-OPEN (design.md Decisión 3): a broken candidate-set read must never
    // break the detail view — it degrades to "no match" ({signals:[],matchedClients:[]},
    // spec.md "Detalle sin ningún match" — never `undefined`).
    let possibleActiveMatch: PossibleActiveMatch = EMPTY_MATCH;
    try {
      const activeContacts = await this.customerRepo.listActiveContacts();
      // SOURCE-AGNOSTIC churn text seam (design.md Decisión 6) — same seam as
      // ListRecaptureLeads; Batch 3B merges in the persisted Contract.motivoBaja
      // of this lead's own clientId.
      const churnReasonTexts = lead.churnReason ? [lead.churnReason] : [];
      possibleActiveMatch = matchActiveClient(
        { clientId: lead.clientId, phone: lead.phone, email: lead.email },
        activeContacts,
        churnReasonTexts,
      );
    } catch {
      possibleActiveMatch = EMPTY_MATCH;
    }

    return {
      ...toRecaptureLeadDetailDto(lead),
      possibleActiveMatch,
    };
  }
}
