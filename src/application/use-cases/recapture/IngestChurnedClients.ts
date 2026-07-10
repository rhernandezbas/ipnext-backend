import { RecaptureRepository } from '@domain/ports/RecaptureRepository';
import { CustomerRepository } from '@domain/ports/CustomerRepository';
import { ContractRepository } from '@domain/ports/ContractRepository';
import { CHURNED_CLIENT_STATUS } from '@domain/entities/customer';

export interface IngestChurnedResult {
  created: number;
  skipped: number;
}

export class IngestChurnedClients {
  constructor(
    private readonly recaptureRepo: RecaptureRepository,
    private readonly customerRepo: CustomerRepository,
    private readonly contractRepo: ContractRepository,
  ) {}

  /**
   * Reads all clients with status='baja' from CustomerRepository and creates
   * RecaptureLeads (source='churned_client') for those that don't already have one.
   * Idempotent — repeated calls are safe.
   *
   * recapture-active-client-match (Decisión 5b): the new lead's `churnReason` is
   * seeded from the client's persisted `Contract.motivoBaja`, batch-read via the
   * SAME anti-N+1 projection ListRecaptureLeads uses (piggyback, zero extra query
   * shape). This only stamps NEW leads (create-only) — an existing lead is never
   * re-stamped; its `churn_reason` coverage comes from reading the contract again
   * at match-time (design.md Decisión 6), not from a backfill here.
   */
  async execute(): Promise<IngestChurnedResult> {
    // Fetch all baja clients (no pagination — operational endpoint, bounded in practice)
    const result = await this.customerRepo.list({ status: CHURNED_CLIENT_STATUS, limit: 10000 });
    const clients = result.data;

    const clientIds = clients.map((c) => c.id);
    const motivoByClientId = new Map<string, string>();
    if (clientIds.length > 0) {
      const rows = await this.contractRepo.findContractTechnologiesByClientIds(clientIds);
      for (const row of rows) {
        if (row.motivoBaja && !motivoByClientId.has(row.clientId)) {
          motivoByClientId.set(row.clientId, row.motivoBaja);
        }
      }
    }

    const created = await this.recaptureRepo.ingestChurned(
      clients.map((c) => ({
        id: c.id,
        name: c.name,
        phone: c.phone ?? null,
        email: c.email ?? null,
        churnReason: motivoByClientId.get(c.id) ?? null,
      })),
    );

    return {
      created,
      skipped: clients.length - created,
    };
  }
}
