export type ReferenceKind = 'category' | 'type' | 'workflow' | 'lead' | 'partner';

export class ReferenceNotFoundError extends Error {
  constructor(public readonly reference: ReferenceKind, public readonly id: string) {
    super(`${reference} not found: ${id}`);
    this.name = 'ReferenceNotFoundError';
  }
}
