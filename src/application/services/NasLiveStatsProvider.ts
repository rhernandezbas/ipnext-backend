import { NasServer } from '@domain/entities/nas';
import { IpNetworkRepository } from '@domain/ports/IpNetworkRepository';
import { RadiusOrchestratorGateway, OrchestratorSession } from '@domain/ports/RadiusOrchestratorGateway';
import { ipInAnyRange } from '@domain/services/ipMath';

/**
 * DTO enriquecido que los use cases de NAS devuelven. Extiende NasServer con displayType,
 * un campo ADITIVO solo en la capa de presentacion (no se persiste, no modifica nas.type).
 */
export interface NasServerDto extends NasServer {
  /** BRAS RADIUS para mikrotik_radius. Para el resto = type crudo. */
  displayType: string;
}

/** Tamano de pagina para paginacion de sesiones del orchestrator. */
const PAGE_SIZE = 100;

/**
 * NasLiveStatsProvider — resuelve EN VIVO clientCount y lastSeen para NAS mikrotik_radius
 * consultando el orchestrator. Los NAS legacy mantienen los valores stored.
 *
 * - Paginacion: carga todas las sesiones via loop (PAGE_SIZE=100) para manejar grandes volumenes.
 * - UNA sola carga global por instancia (cachedSessions como Promise).
 * - Atribuye sesiones por POOLS del NAS (framedIp en algun rango), no por nasIp.
 * - clientCount = usuarios DISTINTOS (dedup por username).
 * - lastSeen = max(startedAt) por Date.parse, output ISO-UTC.
 * - DEGRADA: si cualquier cosa falla, cae al stored (best-effort, nunca lanza, nunca 500).
 * - displayType NUNCA degrada: se calcula antes del try block.
 */
export class NasLiveStatsProvider {
  private cachedSessions: Promise<OrchestratorSession[]> | null = null;

  constructor(
    private readonly ipNetworkRepo: IpNetworkRepository,
    private readonly orchestrator: RadiusOrchestratorGateway,
  ) {}

  private fetchAllSessions(): Promise<OrchestratorSession[]> {
    if (this.cachedSessions) return this.cachedSessions;
    this.cachedSessions = (async () => {
      const all: OrchestratorSession[] = [];
      let offset = 0;
      while (true) {
        const page = await this.orchestrator.listActiveSessions(offset, PAGE_SIZE);
        all.push(...page);
        if (page.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }
      return all;
    })();
    // Note: we do NOT .catch here — enrich() wraps the await in try/catch and degrades to stored
    return this.cachedSessions;
  }

  /**
   * Enriquece un NasServer con clientCount/lastSeen en vivo (si es mikrotik_radius)
   * y anade displayType (aditivo). Nunca lanza: cualquier fallo cae al stored.
   */
  async enrich(nas: NasServer): Promise<NasServerDto> {
    // #6: displayType se calcula ANTES del try — NUNCA degrada
    const displayType = nas.type === 'mikrotik_radius' ? 'BRAS RADIUS' : nas.type;

    if (nas.type !== 'mikrotik_radius') {
      return { ...nas, displayType };
    }

    // #5: todo el bloque de live-stats en try/catch — cualquier fallo -> stored
    try {
      const pools = await this.ipNetworkRepo.findPoolsByNas(nas.id);
      const sessions = await this.fetchAllSessions();

      const attributed = sessions.filter(
        s => s.framedIp !== null && ipInAnyRange(s.framedIp, pools),
      );

      // #7: dedup por username
      const clientCount = new Set(attributed.map(s => s.username)).size;

      // #8: comparacion por Date.parse, output ISO-UTC; filtrar null/falsy
      const withStartedAt = attributed.filter(s => s.startedAt);
      let lastSeen = nas.lastSeen;
      if (withStartedAt.length > 0) {
        const maxMs = withStartedAt.reduce((max, s) => {
          const t = Date.parse(s.startedAt);
          return t > max ? t : max;
        }, Date.parse(withStartedAt[0].startedAt));
        lastSeen = new Date(maxMs).toISOString();
      }

      return { ...nas, clientCount, lastSeen, displayType };
    } catch {
      // #5: fallo total -> stored (best-effort), displayType ya calculado (#6)
      return { ...nas, displayType };
    }
  }

  /**
   * Enriquece una lista de NAS servers. Una sola carga al orchestrator para toda la lista.
   * Degrada individualmente por NAS si un NAS falla en pools -> stored para ese NAS.
   */
  async enrichAll(servers: NasServer[]): Promise<NasServerDto[]> {
    // enrich() never rejects (all error paths return stored inside its own try/catch)
    return Promise.all(servers.map(nas => this.enrich(nas)));
  }
}
