/**
 * RadiusOrchestratorGateway — cliente del radius-orchestrator (FastAPI sobre FreeRADIUS HA,
 * `10.75.0.20:8080`). Espeja FIEL la API REAL del orchestrator (v0.1.0, verificada en vivo):
 *
 *   POST   /users/{username}/plan         → changePlan(username, plan, {applyInSession})
 *   POST   /users/{username}/suspend      → suspend(username, {disconnectActiveSessions, reason})
 *   POST   /users/{username}/reactivate   → reactivate(username)
 *   GET    /users/{username}/sessions     → listSessions(username)
 *   DELETE /users/{username}/sessions     → disconnectSessions(username)   (CoA-Disconnect)
 *
 * Prominense NO conoce el modelo interno del orchestrator (grupos `_SUSPENDED` o priority-shuffle
 * GR): pide el RESULTADO. El mapeo acción-de-corte → llamadas vive en `OrchestratorEnforcementAdapter`.
 * Fallo de red/5xx → `OrchestratorUnreachableError` (el adapter HTTP lo traduce; la ruta → 502).
 */

export interface OrchestratorSession {
  sessionId: string;
  username: string;
  nasIp: string;
  framedIp: string | null;
  startedAt: string;
  bytesIn: number;
  bytesOut: number;
}

export interface ChangePlanOptions {
  /** Aplicar el cambio a la sesión VIVA vía CoA (no esperar al próximo re-dial). */
  applyInSession?: boolean;
}

export interface SuspendOptions {
  /** Desconectar la sesión activa (CoA-Disconnect) para que el corte tome efecto YA. */
  disconnectActiveSessions?: boolean;
  reason?: string;
}

export interface RadiusOrchestratorGateway {
  changePlan(username: string, plan: string, opts?: ChangePlanOptions): Promise<void>;
  suspend(username: string, opts?: SuspendOptions): Promise<void>;
  reactivate(username: string): Promise<void>;
  listSessions(username: string): Promise<OrchestratorSession[]>;
  disconnectSessions(username: string): Promise<void>;
}
