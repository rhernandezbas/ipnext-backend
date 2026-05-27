import { ClientMirrorRepository, UpsertResult } from '@domain/ports/ClientMirrorRepository';
import { GrClient, GrContract } from '@domain/entities/gestionReal';

export class InMemoryClientMirrorRepository implements ClientMirrorRepository {
  clients = new Map<string, GrClient>();
  contracts = new Map<string, GrContract>();

  async upsertClient(client: GrClient): Promise<UpsertResult> {
    const created = !this.clients.has(client.grClienteId);
    this.clients.set(client.grClienteId, client);
    return { created };
  }

  async upsertContract(contract: GrContract): Promise<UpsertResult> {
    const created = !this.contracts.has(contract.grContratoId);
    this.contracts.set(contract.grContratoId, contract);
    return { created };
  }
}
