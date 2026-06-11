import { IClassNode } from '@domain/entities/iclass-node';
import { IClassNodeRepository } from '@domain/ports/IClassNodeRepository';

/**
 * Returns the persisted IClass node catalog, optionally filtered by active/selectable
 * (REQ-NCAT-2). Thin wrapper over the repository. Named distinctly from the existing
 * live `ListIClassNodes` (which hits IClassPort.listNodes() directly for the dispatch
 * dropdown).
 */
export class ListIClassNodeCatalog {
  constructor(private readonly repo: IClassNodeRepository) {}

  execute(filter?: { active?: boolean; selectable?: boolean }): Promise<IClassNode[]> {
    return this.repo.list(filter);
  }
}
