import { ClientMirrorReadRepository } from '@domain/ports/ClientMirrorReadRepository';

/**
 * Test double for the read-only client mirror. Backed by a settable id list so
 * tests can seed the local universe. Exposes no write surface.
 */
export class InMemoryClientMirrorReadRepository implements ClientMirrorReadRepository {
  ids: string[];
  /** finance-growth Fase 3 test seam: local Client.id -> Client.grClienteId. */
  grClienteIdByClientId = new Map<string, string>();

  constructor(ids: string[] = []) {
    this.ids = ids;
  }

  async listGrClienteIds(): Promise<string[]> {
    return this.ids;
  }

  async getGrClienteIdsByClientIds(clientIds: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const id of clientIds) {
      const grId = this.grClienteIdByClientId.get(id);
      if (grId) result.set(id, grId);
    }
    return result;
  }
}
