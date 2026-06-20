import { TicketRepository, CreateTicketData } from '@domain/ports/TicketRepository';
import { Ticket } from '@domain/entities/ticket';
import { EntityLookup } from '@domain/ports/EntityLookup';
import { ReferenceNotFoundError, ContractCustomerMismatchError } from '@domain/errors/scheduling';

/**
 * Contract lookup with OWNERSHIP. Returns `clientId` so the use case can assert
 * the contract belongs to the target customer before creating the ticket.
 * Mirrors the gigared ContractLookup / prismaContractOwnershipLookup precedent.
 */
export interface TicketContractLookup {
  findById(id: string): Promise<{ id: string; clientId: string } | null>;
}

export class CreateTicket {
  /**
   * customerLookup + contractLookup are OPTIONAL constructor params (mirror of
   * CreateTask.ticketLookup): FK + ownership validation runs ONLY when both are
   * wired. Legacy/in-memory test fixtures that build `new CreateTicket(repo)`
   * keep compiling and behave as before (no validation). Production wiring
   * (app.ts) injects both so the contract requirement is enforced end-to-end.
   */
  constructor(
    private readonly repo: TicketRepository,
    private readonly customerLookup?: EntityLookup,
    private readonly contractLookup?: TicketContractLookup,
  ) {}

  async execute(data: CreateTicketData): Promise<Ticket> {
    // FK + ownership validation — only when the lookups are injected. Order
    // mirrors CreateTask: customer → contract → ownership. ReferenceNotFoundError
    // maps to 422 at the route (see tickets.routes.ts REFERENCE_TO_CODE).
    if (this.customerLookup && this.contractLookup) {
      const customerId = data.customerId;
      if (!customerId) throw new ReferenceNotFoundError('customer', '');
      const customer = await this.customerLookup.findById(customerId);
      if (!customer) throw new ReferenceNotFoundError('customer', customerId);

      const contractId = data.contractId;
      if (!contractId) throw new ReferenceNotFoundError('contract', '');
      const contract = await this.contractLookup.findById(contractId);
      if (!contract) throw new ReferenceNotFoundError('contract', contractId);

      // Ownership: the contract MUST belong to the target customer. A foreign
      // contractId is a 422 (no cross-customer ticket).
      if (contract.clientId !== customerId) {
        throw new ContractCustomerMismatchError(contractId, customerId);
      }
    }

    return this.repo.create(data);
  }
}
