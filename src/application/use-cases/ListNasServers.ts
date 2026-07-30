import { NasRepository } from '@domain/ports/NasRepository';
import { IpNetworkRepository } from '@domain/ports/IpNetworkRepository';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
import { maskNasServerSecrets } from '@domain/entities/nas';
import { NasLiveStatsProvider, NasServerDto } from '@application/services/NasLiveStatsProvider';

export class ListNasServers {
  constructor(
    private readonly repo: NasRepository,
    private readonly ipNetworkRepo?: IpNetworkRepository,
    private readonly orchestrator?: RadiusOrchestratorGateway,
  ) {}

  async execute(): Promise<NasServerDto[]> {
    const servers = await this.repo.findAllNasServers();
    if (!this.ipNetworkRepo || !this.orchestrator) {
      // Camino degradado (sin repo de red cableado): no hay de dónde derivar las clases de IP.
      // `[]` = "no determinado" → el FE ofrece ambas y el BE sigue siendo el gate.
      return servers.map(s => ({ ...maskNasServerSecrets(s), displayType: s.type, supportedIpKinds: [] }));
    }
    // #1: provider creado por request (fresh instance -> cachedSessions no congela)
    const liveStats = new NasLiveStatsProvider(this.ipNetworkRepo, this.orchestrator);
    const enriched = await liveStats.enrichAll(servers);
    return enriched.map(maskNasServerSecrets);
  }
}
