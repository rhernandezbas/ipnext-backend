import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
import { PppoeServiceNotFoundError } from '@domain/errors/pppoe';

/**
 * GetPppoeCallerId — devuelve el `callerId` (MAC del CPE) de la sesión PPPoE activa.
 *
 * Consulta `orchestrator.listSessions(username)` y retorna el `callerId` de la primera
 * sesión encontrada. Si no hay sesión activa, retorna `null`.
 *
 * Gated por `pppoe.read`.
 */
export class GetPppoeCallerId {
  constructor(
    private readonly repo: PppoeServiceRepository,
    private readonly orchestrator: RadiusOrchestratorGateway,
  ) {}

  async execute(id: string): Promise<string | null> {
    const s = await this.repo.findById(id);
    if (!s) throw new PppoeServiceNotFoundError(id);

    const sessions = await this.orchestrator.listSessions(s.username);
    const live = sessions[0]?.callerId ?? null;

    // write-through: si vemos una MAC viva nueva, la persistimos (best-effort; no rompe la respuesta).
    if (live && live !== s.callerId) {
      try {
        await this.repo.setCallerId(s.id, live);
      } catch {
        /* best-effort: persistir es secundario, devolvemos la MAC igual */
      }
    }

    // viva si está online; si no, la última guardada (sobrevive a la desconexión).
    return live ?? s.callerId;
  }
}
