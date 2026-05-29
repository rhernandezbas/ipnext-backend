import { GrLinkResolverPort } from '@domain/ports/GrLinkResolverPort';

/**
 * In-memory read-side resolver for tests. Maps GR client/contract ids to the
 * already-mirrored local Client/Service. A miss returns `null` so the ingest
 * can skip+count unmirrored orders without throwing.
 */
export class InMemoryGrLinkResolver implements GrLinkResolverPort {
  private clients = new Map<string, { id: string; name: string }>();
  private services = new Map<string, { id: string; plan: string | null }>();

  /** Test helper: register a mirrored Client keyed by its GR client id. */
  seedClient(grClienteId: string, client: { id: string; name: string }): void {
    this.clients.set(grClienteId, { ...client });
  }

  /** Test helper: register a mirrored Service keyed by its GR contract id. */
  seedService(grContratoId: string, service: { id: string; plan: string | null }): void {
    this.services.set(grContratoId, { ...service });
  }

  async findClientByGrId(grClienteId: string): Promise<{ id: string; name: string } | null> {
    const client = this.clients.get(grClienteId);
    return client ? { ...client } : null;
  }

  async findServiceByGrContratoId(
    grContratoId: string,
  ): Promise<{ id: string; plan: string | null } | null> {
    const service = this.services.get(grContratoId);
    return service ? { ...service } : null;
  }
}
