import { RecaptureRepository } from '@domain/ports/RecaptureRepository';
import { CustomerRepository } from '@domain/ports/CustomerRepository';
import { CHURNED_CLIENT_STATUS } from '@domain/entities/customer';

export interface IngestChurnedResult {
  created: number;
  skipped: number;
}

export class IngestChurnedClients {
  constructor(
    private readonly recaptureRepo: RecaptureRepository,
    private readonly customerRepo: CustomerRepository,
  ) {}

  /**
   * Reads all clients with status='baja' from CustomerRepository and creates
   * RecaptureLeads (source='churned_client') for those that don't already have one.
   * Idempotent — repeated calls are safe.
   */
  async execute(): Promise<IngestChurnedResult> {
    // Fetch all baja clients (no pagination — operational endpoint, bounded in practice)
    const result = await this.customerRepo.list({ status: CHURNED_CLIENT_STATUS, limit: 10000 });
    const clients = result.data;

    const created = await this.recaptureRepo.ingestChurned(
      clients.map((c) => ({
        id: c.id,
        name: c.name,
        phone: c.phone ?? null,
        email: c.email ?? null,
      })),
    );

    return {
      created,
      skipped: clients.length - created,
    };
  }
}
