/**
 * Minimal lookup interface used by FK validation in use cases.
 * Any repository with a findById method satisfies this port.
 */
export interface EntityLookup {
  findById(id: string): Promise<{ id: string } | null>;
}
