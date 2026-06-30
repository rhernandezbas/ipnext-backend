import { RadiusSessionRepository } from '@domain/ports/RadiusSessionRepository';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { RadiusSession } from '@domain/entities/radiusSessions';

/**
 * ListRadiusSessions (gestion-red-sessions) — sesiones RADIUS activas ENRIQUECIDAS con el cruce
 * a contrato (pppoe → contract → client) por `username`.
 *
 * El cruce es BATCH: se juntan TODOS los usernames de las sesiones y se resuelven en UNA sola
 * query (`findByUsernames` → `username IN (...)`), NUNCA N+1 — son potencialmente miles de sesiones.
 *
 * Para cada sesión:
 *   - PppoeService enabled con contrato  → contractId + clientId + customerName
 *   - PppoeService terminated            → los 3 en null (servicio dado de baja → ⚠)
 *   - PppoeService huérfano (sin FK)     → los 3 en null
 *   - sin PppoeService matching          → los 3 en null
 * Los 3 en null = el FE muestra ⚠ ("PPPoE sin contrato asociado").
 */
export class ListRadiusSessions {
  constructor(
    private readonly repo: RadiusSessionRepository,
    private readonly pppoeRepo: PppoeServiceRepository,
  ) {}

  async execute(): Promise<RadiusSession[]> {
    const sessions = await this.repo.listSessions();
    if (sessions.length === 0) return sessions;

    // BATCH: usernames únicos de TODAS las sesiones → una sola query con `IN`.
    const usernames = [...new Set(sessions.map(s => s.username))];
    const pppoes = await this.pppoeRepo.findByUsernames(usernames);

    // Index por username para mapear en O(1). Si un username tuviera más de un PppoeService
    // (no debería: username es UNIQUE), el último gana — irrelevante en la práctica.
    const byUsername = new Map(pppoes.map(p => [p.username, p]));

    return sessions.map(s => {
      const p = byUsername.get(s.username);
      // terminated = servicio dado de baja; tratar como sin contrato para mostrar ⚠ en el FE.
      const linked = p != null && p.status !== 'terminated';
      return {
        ...s,
        contractId:   linked ? (p!.contractId   ?? null) : null,
        clientId:     linked ? (p!.clientId     ?? null) : null,
        customerName: linked ? (p!.customerName ?? null) : null,
      };
    });
  }
}
