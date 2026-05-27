import { GestionRealPort } from '@domain/ports/GestionRealPort';
import { ClientMirrorRepository } from '@domain/ports/ClientMirrorRepository';

export interface ContractSyncResult {
  fetched: number;
  created: number;
  updated: number;
}

/**
 * Refreshes the contracts (Services) of a given set of GR clients. The scheduler
 * feeds it the client ids touched by the client sync, so contracts follow their
 * owner's delta instead of being scanned globally (GR has no contract delta feed).
 */
export class SyncGestionRealContracts {
  constructor(
    private readonly gr: GestionRealPort,
    private readonly mirror: ClientMirrorRepository,
  ) {}

  async execute(grClienteIds: string[]): Promise<ContractSyncResult> {
    let fetched = 0;
    let created = 0;
    let updated = 0;

    for (const cli of grClienteIds) {
      const contracts = await this.gr.fetchContractsByClient(cli);
      for (const contract of contracts) {
        const { created: wasCreated } = await this.mirror.upsertContract(contract);
        if (wasCreated) created++; else updated++;
        fetched++;
      }
    }

    return { fetched, created, updated };
  }
}
