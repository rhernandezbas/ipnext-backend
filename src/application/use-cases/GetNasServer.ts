import { NasRepository } from '@domain/ports/NasRepository';
import { IpNetworkRepository } from '@domain/ports/IpNetworkRepository';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
import { maskNasServerSecrets } from '@domain/entities/nas';
import { NasLiveStatsProvider, NasServerDto } from '@application/services/NasLiveStatsProvider';

export class GetNasServer {
  constructor(
    private readonly repo: NasRepository,
    private readonly ipNetworkRepo?: IpNetworkRepository,
    private readonly orchestrator?: RadiusOrchestratorGateway,
  ) {}

  async execute(id: string): Promise<NasServerDto | null> {
    const server = await this.repo.findNasServerById(id);
    if (!server) return null;
    if (!this.ipNetworkRepo || !this.orchestrator) {
      // Camino degradado (espejo de ListNasServers): sin repo de red no hay de dónde derivar
      // las clases de IP. `[]` = "no determinado".
      return { ...maskNasServerSecrets(server), displayType: server.type, supportedIpKinds: [] };
    }
    // #1: provider creado por request (fresh instance -> cachedSessions no congela)
    const liveStats = new NasLiveStatsProvider(this.ipNetworkRepo, this.orchestrator);
    const enriched = await liveStats.enrich(server);
    return maskNasServerSecrets(enriched);
  }
}
