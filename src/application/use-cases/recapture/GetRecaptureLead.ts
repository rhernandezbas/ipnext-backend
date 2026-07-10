import { RecaptureRepository } from '@domain/ports/RecaptureRepository';
import { CustomerRepository } from '@domain/ports/CustomerRepository';
import { ContractRepository } from '@domain/ports/ContractRepository';
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
    private readonly contractRepo: ContractRepository,
  ) {}

  async execute(id: string): Promise<RecaptureLeadDetailDto> {
    const lead = await this.repo.getById(id);
    if (!lead) throw new RecaptureLeadNotFoundError(id);

    // Fail-OPEN (design.md Decisión 3): a broken candidate-set read must never
    // break the detail view — it degrades to "no match" ({signals:[],matchedClients:[]},
    // spec.md "Detalle sin ningún match" — never `undefined`). The contract read
    // (motivoBaja) is inside the SAME try/catch — a broken contract lookup must
    // never break the detail view either.
    let possibleActiveMatch: PossibleActiveMatch = EMPTY_MATCH;
    try {
      const activeContacts = await this.customerRepo.listActiveContacts();
      // SOURCE-AGNOSTIC churn text seam (design.md Decisión 6) — same seam as
      // ListRecaptureLeads: merges `lead.churnReason` AND every persisted
      // `Contract.motivoBaja` of THIS lead's own clientId (single-client read,
      // not N+1 — only ONE lead is being resolved here).
      const motivoTexts = lead.clientId
        ? (await this.contractRepo.findContractTechnologiesByClientIds([lead.clientId]))
            .map((row) => row.motivoBaja)
            .filter((m): m is string => !!m)
        : [];
      const churnReasonTexts = [lead.churnReason, ...motivoTexts].filter(
        (t): t is string => !!t,
      );
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
