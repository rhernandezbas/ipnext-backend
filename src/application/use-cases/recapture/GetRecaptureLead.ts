import { RecaptureRepository } from '@domain/ports/RecaptureRepository';
import { CustomerRepository, ActiveClientContact } from '@domain/ports/CustomerRepository';
import { ContractRepository } from '@domain/ports/ContractRepository';
import { RecaptureLeadNotFoundError } from '@domain/errors/recapture';
import {
  RecaptureLeadDetailDto,
  PossibleActiveMatch,
  toRecaptureLeadDetailDto,
} from '@application/dto/recapture/recapture.dto';
import { matchActiveClient } from '@application/use-cases/recapture/matchActiveClient';

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
    // spec.md "Detalle sin ningún match" — never `undefined`).
    // Fix-wave Finding 1/3b — the active-contacts read and the contract read are
    // now GUARDED SEPARATELY: a broken contract lookup must never wipe out signals
    // that were already computed from a SUCCESSFUL active-contacts read (phone/email/
    // reactivated), and vice versa. `matchActiveClient` is pure/total, so calling it
    // once at the end with whatever data survived is always safe (never throws).
    let activeContacts: ActiveClientContact[] = [];
    try {
      activeContacts = await this.customerRepo.listActiveContacts();
    } catch (err) {
      // Fix-wave Finding 2 — operational trace for prod (design.md Decisión 3: "ante error → log + []").
      console.warn(`[recapture-match] GetRecaptureLead(${id}): listActiveContacts falló — FAIL-OPEN ([] contactos activos):`, err);
      activeContacts = [];
    }

    // SOURCE-AGNOSTIC churn text seam (design.md Decisión 6) — same seam as
    // ListRecaptureLeads: merges `lead.churnReason` AND every persisted
    // `Contract.motivoBaja` of THIS lead's own clientId (single-client read,
    // not N+1 — only ONE lead is being resolved here).
    let motivoTexts: string[] = [];
    if (lead.clientId) {
      try {
        motivoTexts = (await this.contractRepo.findContractTechnologiesByClientIds([lead.clientId]))
          .map((row) => row.motivoBaja)
          .filter((m): m is string => !!m);
      } catch (err) {
        console.warn(`[recapture-match] GetRecaptureLead(${id}): findContractTechnologiesByClientIds falló — FAIL-OPEN (motivoBaja de contrato perdido):`, err);
        motivoTexts = [];
      }
    }

    const churnReasonTexts = [lead.churnReason, ...motivoTexts].filter(
      (t): t is string => !!t,
    );
    const possibleActiveMatch: PossibleActiveMatch = matchActiveClient(
      { clientId: lead.clientId, phone: lead.phone, email: lead.email },
      activeContacts,
      churnReasonTexts,
    );

    return {
      ...toRecaptureLeadDetailDto(lead),
      possibleActiveMatch,
    };
  }
}
