import { NetworkSite } from '@domain/entities/networkSite';
import { NetworkSiteRepository } from '@domain/ports/NetworkSiteRepository';
import { IClassNodeRepository } from '@domain/ports/IClassNodeRepository';
import { IClassNodeNotFoundError, IClassNodeNotAssignableError } from '@domain/errors/iclass';

/**
 * Assigns (or clears) an IClass node mapping on a NetworkSite (REQ-NCAT-3).
 *
 * - Non-null id → the node MUST exist (else IClassNodeNotFoundError), be `active`
 *   and `selectable` (else IClassNodeNotAssignableError). On success, persists
 *   atomically `iclassNodeCode = node.code` AND `city = node.code`.
 * - null → clears only `iclassNodeCode`; `city` is left intact (conservative: does
 *   not break readiness/dispatch of already-configured sites).
 *
 * Returns the updated NetworkSite, or null if the site does not exist
 * (the route maps null → 404).
 */
export class AssignIClassNodeToNetworkSite {
  constructor(
    private readonly sites: NetworkSiteRepository,
    private readonly nodes: IClassNodeRepository,
  ) {}

  async execute(siteId: string, iclassNodeId: string | null): Promise<NetworkSite | null> {
    if (iclassNodeId === null) {
      return this.sites.update(siteId, { iclassNodeCode: null });
    }

    const node = await this.nodes.getById(iclassNodeId);
    if (!node) throw new IClassNodeNotFoundError(iclassNodeId);
    if (!node.active) {
      throw new IClassNodeNotAssignableError(node.code, 'el nodo está inactivo');
    }
    if (!node.selectable) {
      throw new IClassNodeNotAssignableError(node.code, 'el nodo es un agrupador no asignable');
    }

    return this.sites.update(siteId, { iclassNodeCode: node.code, city: node.code });
  }
}
