/**
 * RadiusOrchestratorGateway — cliente del radius-orchestrator (FastAPI sobre FreeRADIUS HA,
 * `10.75.0.20:8080`). Espeja FIEL la API REAL del orchestrator (v0.1.0, verificada en vivo):
 *
 *   POST   /users/{username}/plan         → changePlan(username, plan, {applyInSession})
 *   POST   /users/{username}/password     → changePassword(username, password)
 *   POST   /users/{username}/framed-ip    → changeFramedIp(username, framedIp)
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

/**
 * Item del INVENTARIO de usuarios del RADIUS (`GET /users`). Es la verdad técnica del FreeRADIUS:
 * incluye la `password` (cleartext) porque el objetivo es ADOPTAR el inventario existente
 * (cargar los PPPoE reales como filas huérfanas con su clave). `framedIp`/`plan` pueden faltar.
 */
export interface RadiusUserInventoryItem {
  username: string;
  password: string;
  plan: string | null;
  framedIp: string | null;
}

/** Alta de un usuario en el RADIUS. Corresponde a `POST /users` del orchestrator. */
export interface CreateRadiusUserInput {
  username: string;
  password: string;
  /** Grupo/plan del RADIUS (radusergroup). Obligatorio: un usuario RADIUS necesita su grupo. */
  plan: string;
  /** IP fija opcional (radreply Framed-IP-Address). `null`/ausente → IP del pool. */
  framedIp?: string | null;
}

export interface RadiusOrchestratorGateway {
  /**
   * Crea el usuario en el RADIUS (radcheck + radusergroup + radreply Framed-IP-Address).
   * Corresponde a `POST /users` con body `{ username, password, plan, framed_ip }`.
   * Usuario duplicado (orchestrator 409) → `OrchestratorRejectedError` (la ruta → 409).
   */
  createUser(input: CreateRadiusUserInput): Promise<void>;

  /**
   * Lista el INVENTARIO completo de usuarios del RADIUS (con su password cleartext).
   * Corresponde a `GET /users` → `[{username, password, plan, framed_ip}]` (verificado en vivo).
   * Es la fuente para ADOPTAR el inventario PPPoE existente (cargarlo como filas huérfanas).
   */
  listUsers(): Promise<RadiusUserInventoryItem[]>;
  changePlan(username: string, plan: string, opts?: ChangePlanOptions): Promise<void>;
  /**
   * Cambia la contraseña del usuario en el RADIUS (radcheck Cleartext-Password).
   * Corresponde a `POST /users/{username}/password` con body `{ password }`.
   */
  changePassword(username: string, password: string): Promise<void>;
  /**
   * Cambia la IP fija del usuario en el RADIUS (radreply Framed-IP-Address).
   * `null` → libera la IP fija y el usuario toma IP del pool.
   * Corresponde a `POST /users/{username}/framed-ip` con body `{ framed_ip }`.
   */
  changeFramedIp(username: string, framedIp: string | null): Promise<void>;
  suspend(username: string, opts?: SuspendOptions): Promise<void>;
  reactivate(username: string): Promise<void>;
  listSessions(username: string): Promise<OrchestratorSession[]>;
  disconnectSessions(username: string): Promise<void>;

  /**
   * Sincroniza (crea o actualiza) el plan en el radgroupreply del RADIUS.
   * Escribe `Mikrotik-Rate-Limit` (calculado de kbps) y `Framed-Pool` si `pool` está presente.
   * Corresponde a `PUT /plans/{code}` en el radius-orchestrator.
   */
  syncPlan(code: string, downloadKbps: number, uploadKbps: number, pool?: string | null): Promise<void>;

  /**
   * Elimina el plan del radgroupreply del RADIUS.
   * Corresponde a `DELETE /plans/{code}` en el radius-orchestrator.
   */
  deletePlan(code: string): Promise<void>;

  /**
   * Lista las IPs ASIGNADAS en el RADIUS (radreply Framed-IP-Address de todos los usuarios).
   * Corresponde a `GET /assigned-ips` → body `{ ips: ["100.64.10.42", ...] }`.
   *
   * Para un NAS `mikrotik_radius` el RADIUS —no el router— es la fuente de verdad de las IPs
   * tomadas: el allocator excluye ESTA lista al buscar un IP libre (evita el 409 al crear).
   */
  listAssignedIps(): Promise<string[]>;
}
