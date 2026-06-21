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
    if (sessions.length === 0) return null;

    return sessions[0]!.callerId;
  }
}
