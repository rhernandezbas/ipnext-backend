import { RadiusSession } from '@domain/entities/radiusSessions';
import { RadiusSessionRepository } from '@domain/ports/RadiusSessionRepository';
import { RadiusOrchestratorGateway, OrchestratorSession } from '@domain/ports/RadiusOrchestratorGateway';

/** Tamaño de página para paginar el GET /sessions del orchestrator. */
const PAGE_SIZE = 100;

/**
 * OrchestratorRadiusSessionRepository — fuente REAL de las sesiones del tab "Sesiones activas".
 *
 * El bug original: `PrismaRadiusSessionRepository.listSessions()` lee la tabla LOCAL `radiusSession`,
 * que NUNCA se popula (mock) → el FE siempre veía 0. Este adapter, en cambio, consulta las sesiones
 * PPPoE VIVAS del radius-orchestrator (`GET /sessions`) vía `gateway.listActiveSessions()` y mapea
 * `OrchestratorSession` → `RadiusSession`.
 *
 * El cruce a contrato (pppoe → contract → client) lo sigue resolviendo `ListRadiusSessions` (use case)
 * por `username` en BATCH; este repo deja `contractId/clientId/customerName` en `null`.
 *
 * LÍMITE CONOCIDO (NO es bug): el RADIUS HA detrás del orchestrator solo termina Acceso Sur / NE8000.
 * Las sesiones de los MikroTik legacy (Fibra RDA1/RDA2, CGNAT, etc.) NO están en `GET /sessions`,
 * así que NO aparecen acá. Es el alcance real del orchestrator, no una pérdida de datos del adapter.
 *
 * Fallo de red / 5xx del orchestrator → `OrchestratorUnreachableError` (la ruta lo mapea a 502).
 */
export class OrchestratorRadiusSessionRepository implements RadiusSessionRepository {
  constructor(private readonly gateway: RadiusOrchestratorGateway) {}

  async listSessions(): Promise<RadiusSession[]> {
    const all = await this.fetchAll();
    const now = Date.now();
    return all.map(s => toRadiusSession(s, now));
  }

  /**
   * Desconecta la sesión viva identificada por `id` (= `sessionId` del orchestrator).
   *
   * El FE manda `DELETE /sessions/:id` con el `sessionId`, pero el CoA-Disconnect del orchestrator
   * es por usuario (`DELETE /users/:username/sessions`). Resolvemos el username buscando la sesión
   * viva con ese `sessionId` y delegamos al gateway. Si ya no está viva → success false (idempotente).
   */
  async disconnectSession(id: string): Promise<{ success: boolean }> {
    const all = await this.fetchAll();
    const match = all.find(s => s.sessionId === id);
    if (!match) return { success: false };
    await this.gateway.disconnectSessions(match.username);
    return { success: true };
  }

  /** Carga TODAS las sesiones vivas paginando el GET /sessions (PAGE_SIZE=100). */
  private async fetchAll(): Promise<OrchestratorSession[]> {
    const all: OrchestratorSession[] = [];
    let offset = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page = await this.gateway.listActiveSessions(offset, PAGE_SIZE);
      all.push(...page);
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
    return all;
  }
}

/**
 * Mapea una sesión del orchestrator a la entidad RadiusSession del FE.
 *
 * - `id`/`sessionId`: el sessionId del orchestrator (no hay id local; sirve para el DELETE).
 * - `nasId`/`nasName`: el orchestrator solo expone `nasIp` → ambos = nasIp.
 * - `ipAddress` ← framedIp, `macAddress` ← callerId (caller-id / MAC del CPE).
 * - `downloadBytes` ← bytesOut (acctoutputoctets = bajada), `uploadBytes` ← bytesIn (acctinputoctets = subida).
 * - `downloadMbps`/`uploadMbps`: el orchestrator NO expone tasa instantánea → 0.
 * - `duration`: computado = segundos desde startedAt (el orchestrator no lo expone).
 * - `status`: siempre 'active' (GET /sessions solo devuelve sesiones vivas).
 * - cruce a contrato (contractId/clientId/customerName): lo llena el use case → null acá.
 */
function toRadiusSession(s: OrchestratorSession, nowMs: number): RadiusSession {
  const startedMs = Date.parse(s.startedAt);
  const duration = Number.isNaN(startedMs) ? 0 : Math.max(0, Math.floor((nowMs - startedMs) / 1000));

  return {
    id: s.sessionId,
    sessionId: s.sessionId,
    clientName: s.username,        // display crudo del RADIUS; el customerName real lo trae el cruce
    nasId: s.nasIp,
    nasName: s.nasIp,
    ipAddress: s.framedIp,
    macAddress: s.callerId,
    startedAt: s.startedAt,
    duration,
    downloadBytes: s.bytesOut,
    uploadBytes: s.bytesIn,
    downloadMbps: 0,
    uploadMbps: 0,
    status: 'active',
    username: s.username,
    contractId: null,
    clientId: null,
    customerName: null,
  };
}
