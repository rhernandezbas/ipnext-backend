import type { ClientPortalLookup, ClientPortalLookupResult, ClientPortalNameResult } from '@domain/ports/ClientPortalLookup';
import { extractPortalDni } from '@domain/services/extractPortalDni';

/** InMemoryClientPortalLookup — test seam (Fase 3, task 3.1). */
export class InMemoryClientPortalLookup implements ClientPortalLookup {
  private readonly store = new Map<string, { name: string; customAttributes: unknown }>();

  /** Test setup helper — seeds a client mirror row. */
  seed(id: string, name: string, customAttributes: unknown = null): void {
    this.store.set(id, { name, customAttributes });
  }

  async findById(clientId: string): Promise<ClientPortalLookupResult | null> {
    const row = this.store.get(clientId);
    if (!row) return null;
    return { id: clientId, name: row.name, documento: extractPortalDni(row.customAttributes) };
  }

  async findNamesByIds(clientIds: string[]): Promise<ClientPortalNameResult[]> {
    const out: ClientPortalNameResult[] = [];
    for (const id of clientIds) {
      const row = this.store.get(id);
      if (row) out.push({ id, name: row.name });
    }
    return out;
  }
}
