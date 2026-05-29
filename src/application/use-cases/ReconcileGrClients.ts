import { GestionRealPort, FetchClientsParams } from '@domain/ports/GestionRealPort';
import { ClientMirrorReadRepository } from '@domain/ports/ClientMirrorReadRepository';
import { ReconcileReportDTO } from '@application/dto/ReconcileReportDTO';

const DEFAULT_PAGE_SIZE = 100;

export interface ReconcileOptions {
  /** Page size for the GR full-universe scan. Defaults to 100 (GR's cap). */
  pageSize?: number;
}

/**
 * Read-only diagnostic: pages GR's FULL universe (no estado filter) and
 * set-diffs it against the local mirror's grClienteId set.
 *
 * Injected with read ports ONLY (GestionRealPort + ClientMirrorReadRepository),
 * so it is structurally incapable of mutating the mirror (REQ-REC-READONLY-1).
 * It intentionally does NOT read config.gestionReal.estados — the reconcile
 * always scans the complete universe so the comparison is apples-to-apples
 * regardless of the sync's GR_SYNC_ESTADOS (REQ-REC-DIFF-1).
 */
export class ReconcileGrClients {
  private readonly pageSize: number;

  constructor(
    private readonly gr: GestionRealPort,
    private readonly mirror: ClientMirrorReadRepository,
    opts: ReconcileOptions = {},
  ) {
    this.pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  }

  async execute(): Promise<ReconcileReportDTO> {
    const localIds = await this.mirror.listGrClienteIds();
    const grIds = await this.fetchFullUniverse();

    const grSet = new Set(grIds);
    const localSet = new Set(localIds);

    const localOnly = [...localSet].filter(id => !grSet.has(id));
    const grOnly = [...grSet].filter(id => !localSet.has(id));

    return {
      localTotal: localSet.size,
      grTotal: grSet.size,
      localOnlyCount: localOnly.length,
      grOnlyCount: grOnly.length,
      localOnly,
      grOnly,
    };
  }

  /** Sequential paginated scan of the entire GR client universe — no estado, no date filter. */
  private async fetchFullUniverse(): Promise<string[]> {
    const ids: string[] = [];
    let offset = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const params: FetchClientsParams = { cantidad: this.pageSize, offset };
      const { total, clients } = await this.gr.fetchClients(params);
      for (const client of clients) ids.push(client.grClienteId);
      offset += this.pageSize;
      if (clients.length === 0 || offset >= total) break;
    }
    return ids;
  }
}
