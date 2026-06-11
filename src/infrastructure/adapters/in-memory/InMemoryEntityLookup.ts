import { EntityLookup } from '@domain/ports/EntityLookup';
import { ProjectKindLookup } from '@domain/ports/ProjectKindLookup';

/**
 * Reusable in-memory lookup for use in tests.
 * Pre-populated with a list of { id } objects — any other id returns null.
 *
 * Satisfies both EntityLookup and ProjectKindLookup (#40): the return shape is a
 * superset of `{ id }`, so it can back any FK slot in CreateTask, including the
 * widened project slot. `isNetworkProject` defaults to false; pass a flag map to
 * override per id when a test needs network projects.
 */
export class InMemoryEntityLookup implements EntityLookup, ProjectKindLookup {
  private ids: Set<string>;
  private networkFlags: Map<string, boolean>;

  constructor(entities: { id: string; isNetworkProject?: boolean }[]) {
    this.ids = new Set(entities.map((e) => e.id));
    this.networkFlags = new Map(entities.map((e) => [e.id, e.isNetworkProject ?? false]));
  }

  /** Add an id after construction (test helper). */
  add(id: string, isNetworkProject = false): void {
    this.ids.add(id);
    this.networkFlags.set(id, isNetworkProject);
  }

  async findById(id: string): Promise<{ id: string; isNetworkProject: boolean } | null> {
    return this.ids.has(id) ? { id, isNetworkProject: this.networkFlags.get(id) ?? false } : null;
  }
}
