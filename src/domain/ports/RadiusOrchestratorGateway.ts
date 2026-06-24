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
  /** MAC address del CPE (caller-id del NAS). `null` si el orchestrator no lo expone. */
  callerId: string | null;
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

// ── Accounting / radacct types (design.md § "Gateway port addition") ──────────────────────────

/**
 * Filtros para GET /accounting del radius-orchestrator.
 * Los parámetros se mapean a query params en snake_case por HttpRadiusOrchestratorGateway.
 *
 * FIX2: el cursor y la ventana ahora son sobre acctupdatetime (sinceUpdate/untilUpdate).
 * Esto permite detectar sesiones que cierran dias despues de conectarse (el startedAt viejo
 * quedaba fuera de la ventana, el acctupdatetime al cerrar queda DENTRO).
 * El orchestrator expone since_update/until_update en el GET /accounting.
 */
export interface ListAccountingFilters {
  /**
   * ISO 8601 — ingest cursor: WHERE acctupdatetime >= sinceUpdate.
   * FIX2: reemplaza sinceStart para detectar sesiones cuyo cierre es reciente
   * aunque el startedAt sea antiguo (sesiones de dias de duracion).
   */
  sinceUpdate?: string;
  /** ISO 8601 — upper bound (backfill) sobre acctupdatetime */
  untilUpdate?: string;
  /** exact username filter */
  username?: string;
  /** exact nasipaddress filter */
  nasIpAddress?: string;
  /** 1-based page number (default 1) */
  page?: number;
  /** rows per page (orchestrator default 500, max 1000) */
  pageSize?: number;
}

/**
 * Un evento de accounting (una fila de radacct) tal como lo devuelve el orchestrator,
 * ya mapeado a camelCase. Octets ya parseados a bigint.
 *
 * FIX2: se agrega `lastUpdate` (acctupdatetime del radacct). Este campo se actualiza
 * cuando la sesion cierra (acctstoptime se llena). Usarlo como cursor permite detectar
 * sesiones cuyo startedAt es antiguo pero que cerraron recientemente.
 */
export interface AccountingEventRow {
  uniqueId: string;
  username: string;
  nasIpAddress: string;
  framedIp: string | null;
  macAddress: string | null;
  /** VLAN parseado del nasportid por el orchestrator (null si no aplica). */
  vlan: number | null;
  startedAt: string;       // ISO 8601
  stoppedAt: string | null;
  sessionTime: number | null;
  inOctets: bigint;
  outOctets: bigint;
  /**
   * acctupdatetime del radacct — se actualiza al cerrar la sesion.
   * FIX2: cursor del ingest. null si el orchestrator no lo expone (fallback a startedAt).
   */
  lastUpdate: string | null;
}

/**
 * Respuesta paginada de GET /accounting.
 * El orchestrator usa paginación 1-based con next_page=null en la última página.
 */
export interface AccountingPage {
  items: AccountingEventRow[];
  page: number;
  pageSize: number;
  /** null cuando es la última página */
  nextPage: number | null;
}

// ── Postauth / auth events types (espejo de accounting) ───────────────────────────────────────

/**
 * Filtros para GET /postauth del radius-orchestrator (eventos de autenticación: radpostauth).
 * Los parámetros se mapean a query params snake_case por HttpRadiusOrchestratorGateway.
 *
 * El cursor del ingest es authdate (since_authdate). NO hay nasipaddress en postauth.
 */
export interface ListPostauthFilters {
  /** ISO 8601 — ingest cursor: WHERE authdate >= sinceAuthdate. */
  sinceAuthdate?: string;
  /** ISO 8601 — upper bound (backfill) sobre authdate. */
  untilAuthdate?: string;
  /** exact username filter */
  username?: string;
  /** exact reply filter: 'Access-Accept' | 'Access-Reject' */
  reply?: string;
  /** 1-based page number (default 1) */
  page?: number;
  /** rows per page (orchestrator default 500, max 1000) */
  pageSize?: number;
}

/**
 * Un evento de auth (una fila de radpostauth) tal como lo devuelve el orchestrator,
 * ya mapeado a camelCase. El `pass` NO viene — el orchestrator no lo expone.
 */
export interface AuthEventRow {
  sourceId: string;
  username: string;
  /** 'Access-Accept' | 'Access-Reject' */
  reply: string;
  authdate: string;        // ISO 8601
  class: string | null;
}

/**
 * Respuesta paginada de GET /postauth.
 * El orchestrator usa paginación 1-based con next_page=null en la última página.
 */
export interface PostauthPage {
  items: AuthEventRow[];
  page: number;
  pageSize: number;
  /** null cuando es la última página */
  nextPage: number | null;
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
   * Elimina el usuario del RADIUS (radcheck + radusergroup + radreply).
   * Libera la Framed-IP-Address asignada y borra el acceso completamente.
   * Corresponde a `DELETE /users/{username}` → 204 del orchestrator.
   * Fallo de red/5xx → `OrchestratorUnreachableError` (la ruta → 502).
   */
  deleteUser(username: string): Promise<void>;

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

  /**
   * Lista TODAS las sesiones PPPoE activas del RADIUS (todas las cuentas en el NAS RADIUS).
   * Corresponde a `GET /sessions?offset={offset}&limit={limit}` del orchestrator.
   * Parsea 1:1 igual que `listSessions(username)` pero sin filtrar por usuario.
   * Fallo de red/5xx → `OrchestratorUnreachableError`.
   */
  listActiveSessions(offset?: number, limit?: number): Promise<OrchestratorSession[]>;

  /**
   * Consulta el histórico de accounting (`radacct`) via el radius-orchestrator.
   * Corresponde a `GET /accounting` con paginación 1-based.
   * Usado por el ingest scheduler para llenar `RadiusEvent`.
   */
  listAccounting(filters: ListAccountingFilters): Promise<AccountingPage>;

  /**
   * Consulta el histórico de autenticación (`radpostauth`) via el radius-orchestrator.
   * Corresponde a `GET /postauth` con paginación 1-based (orden authdate ASC).
   * Usado por el ingest scheduler para llenar `RadiusAuthEvent`.
   */
  listPostauth(filters: ListPostauthFilters): Promise<PostauthPage>;
}
