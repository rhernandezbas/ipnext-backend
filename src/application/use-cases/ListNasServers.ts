import { NasRepository } from '@domain/ports/NasRepository';
import { IpNetworkRepository } from '@domain/ports/IpNetworkRepository';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
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
      return servers.map(s => ({ ...s, displayType: s.type }));
    }
    // #1: provider creado por request (fresh instance -> cachedSessions no congela)
    const liveStats = new NasLiveStatsProvider(this.ipNetworkRepo, this.orchestrator);
    return liveStats.enrichAll(servers);
  }
}
