import { ClientMirrorReadRepository } from '@domain/ports/ClientMirrorReadRepository';

/**
 * Test double for the read-only client mirror. Backed by a settable id list so
 * tests can seed the local universe. Exposes no write surface.
 */
export class InMemoryClientMirrorReadRepository implements ClientMirrorReadRepository {
  ids: string[];

  constructor(ids: string[] = []) {
    this.ids = ids;
  }

  async listGrClienteIds(): Promise<string[]> {
    return this.ids;
  }
}
