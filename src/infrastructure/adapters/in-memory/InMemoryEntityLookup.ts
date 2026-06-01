import { EntityLookup } from '@domain/ports/EntityLookup';

/**
 * Reusable in-memory EntityLookup for use in tests.
 * Pre-populated with a list of { id } objects — any other id returns null.
 */
export class InMemoryEntityLookup implements EntityLookup {
  private ids: Set<string>;

  constructor(entities: { id: string }[]) {
    this.ids = new Set(entities.map((e) => e.id));
  }

  /** Add an id after construction (test helper). */
  add(id: string): void {
    this.ids.add(id);
  }

  async findById(id: string): Promise<{ id: string } | null> {
    return this.ids.has(id) ? { id } : null;
  }
}
