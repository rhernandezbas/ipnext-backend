import {
  RadiusOrchestratorGateway,
  OrchestratorSession,
  ChangePlanOptions,
  SuspendOptions,
  CreateRadiusUserInput,
  RadiusUserInventoryItem,
  ListAccountingFilters,
  AccountingPage,
  AccountingEventRow,
  ListPostauthFilters,
  PostauthPage,
  AuthEventRow,
  CureSessionResult,
} from '@domain/ports/RadiusOrchestratorGateway';
import { OrchestratorUnreachableError, OrchestratorRejectedError } from '@domain/errors/pppoe';

interface UserState {
  plan: string;
  suspended: boolean;
  password?: string;
  framedIp?: string | null;
}

export interface InMemoryOrchestratorSeed {
  username: string;
  plan?: string;
  suspended?: boolean;
  sessions?: OrchestratorSession[];
}

/** Seed de accounting para tests del ingest scheduler. */
export interface AccountingEventSeed extends AccountingEventRow {}

/** Seed de postauth (auth events) para tests del ingest scheduler. */
export interface AuthEventSeed extends AuthEventRow {}

interface UserCallLog {
  op: 'createUser' | 'changePlan' | 'changePassword' | 'changeFramedIp' | 'suspend' | 'reactivate' | 'disconnectSessions' | 'deleteUser';
  username: string;
  arg?: unknown;
}

/** Snapshot del `createUser` registrado (normalizado: framedIp siempre presente, default null). */
export interface CreatedRadiusUser {
  username: string;
  password: string;
  plan: string;
  framedIp: string | null;
}

export interface PlanCallLog {
  op: 'syncPlan' | 'deletePlan';
  code: string;
  downloadKbps?: number;
  uploadKbps?: number;
  pool?: string | null;
}

export interface PlanRejectionSeed {
  code: string;
  /** HTTP status que el orchestrator devolvería (4xx). */
  status: number;
  detail?: string;
}

/**
 * InMemoryRadiusOrchestratorGateway — doble de test del orchestrator. Modela el estado por-usuario
 * (plan + suspended + sesiones) y registra las llamadas (`calls`, `planCalls`) para aserciones.
 *
 * - `unreachable`: simula el orchestrator caído para usuarios específicos (→ `OrchestratorUnreachableError`).
 * - `failForPlanCode`: simula el orchestrator caído para códigos de plan específicos (→ `OrchestratorUnreachableError`).
 * - `rejectPlanCode`: simula el orchestrator RECHAZANDO un plan con 4xx (→ `OrchestratorRejectedError`).
 * - `onSyncPlan`: callback opcional llamado al ejecutar syncPlan (útil para capturar orden de llamadas).
 */
export class InMemoryRadiusOrchestratorGateway implements RadiusOrchestratorGateway {
  private readonly state = new Map<string, UserState>();
  private readonly sessions = new Map<string, OrchestratorSession[]>();
  private readonly createdUsers = new Map<string, CreatedRadiusUser>();
  private readonly unreachable: Set<string>;
  private readonly failForPlanCode: Set<string>;
  private readonly rejectPlanCode: Map<string, PlanRejectionSeed>;
  private readonly onSyncPlanCb: (() => void) | undefined;
  /** IPs asignadas en el RADIUS (radreply Framed-IP) que devuelve listAssignedIps.
   *  fix wave 1 (pppoe-move-nas ajuste 2): MUTABLE — changeFramedIp registra acá la IP escrita
   *  (y libera la anterior del mismo usuario), igual que el radreply real. */
  private readonly assignedIps: string[];
  /**
   * fix wave 1 (pppoe-move-nas ajuste 2): dueño de cada Framed-IP ESCRITA via changeFramedIp
   * (ip → username). Modela el guard AUTORITATIVO del orchestrator real (verificado en
   * user_management_service.py:203-218): escribir una IP ya asignada a OTRO username rechaza
   * con FramedIpAlreadyAssigned → HTTP 409 (OrchestratorRejectedError).
   * Las IPs sembradas por `assignedIps` quedan ANÓNIMAS: cuentan como tomadas para
   * listAssignedIps pero NO rechazan la escritura (no se conoce el dueño — p.ej. el re-pin
   * de un servicio a su propia IP sembrada debe seguir funcionando).
   */
  private readonly ipOwners = new Map<string, string>();
  /** Si true, listAssignedIps lanza OrchestratorUnreachableError (simula orchestrator caído). */
  private readonly assignedIpsUnreachable: boolean;
  /** Inventario que devuelve listUsers (GET /users). Sembrable para tests de ingest/adopción. */
  private readonly usersInventory: RadiusUserInventoryItem[];
  /** Sesiones globales que devuelve listActiveSessions (GET /sessions). */
  private readonly globalSessionsList: OrchestratorSession[];
  /** Si true, listActiveSessions lanza OrchestratorUnreachableError (simula orchestrator caído). */
  private readonly globalSessionsUnreachable: boolean;
  /** Eventos de accounting que devuelve listAccounting. Sembrable para tests del scheduler. */
  private readonly accountingEvents: AccountingEventRow[];
  /** Eventos de auth (postauth) que devuelve listPostauth. Sembrable para tests del scheduler. */
  private readonly authEvents: AuthEventRow[];

  /**
   * radius-session-autocure (REQ-CURE-3/D9) — sessionIds sembrados para simular el 404 upstream
   * (find_any_by_id no encuentra NADA — ni abierta ni cerrada). cureSession() los rechaza con
   * OrchestratorRejectedError(404) en vez del alreadyClosed:true por defecto.
   */
  private readonly cureNotFoundSessionIds: Set<string>;
  /** Status del CoA que devuelve cureSession por defecto ('ack' | 'timeout' | 'nak' | ...). */
  private readonly cureCoaStatus: string;
  /** Log de llamadas a cureSession, para aserciones (encodeURIComponent, orden, etc). */
  public readonly cureCalls: { username: string; sessionId: string }[] = [];

  public readonly calls: UserCallLog[] = [];
  public readonly planCalls: PlanCallLog[] = [];

  constructor(opts?: {
    unreachable?: string[];
    seed?: InMemoryOrchestratorSeed[];
    /** Códigos de plan para los que syncPlan/deletePlan deben lanzar OrchestratorUnreachableError (red/5xx). */
    failForPlanCode?: string[];
    /**
     * Códigos de plan para los que syncPlan/deletePlan deben lanzar OrchestratorRejectedError (4xx).
     * Útil para probar que la ruta retorna el mismo status que el orchestrator (no 502).
     */
    rejectPlanCode?: PlanRejectionSeed[];
    /** Callback llamado justo antes de registrar una syncPlan exitosa (para tests de orden). */
    onSyncPlan?: () => void;
    /** IPs asignadas que devolverá listAssignedIps (radreply Framed-IP). Default: []. */
    assignedIps?: string[];
    /** Si true, listAssignedIps lanza OrchestratorUnreachableError (simula orchestrator caído). Default: false. */
    assignedIpsUnreachable?: boolean;
    /** Inventario que devolverá listUsers (GET /users). Default: []. */
    usersInventory?: RadiusUserInventoryItem[];
    /** Sesiones globales que devolverá listActiveSessions (GET /sessions). Default: []. */
    globalSessions?: OrchestratorSession[];
    /** Si true, listActiveSessions lanza OrchestratorUnreachableError. Default: false. */
    globalSessionsUnreachable?: boolean;
    /**
     * Eventos de accounting que devolverá listAccounting (semilla para tests del scheduler).
     * listAccounting aplica filtros de `username` y `status` si la semilla los contiene.
     * Default: [].
     */
    accountingEvents?: AccountingEventRow[];
    /**
     * Eventos de auth (postauth) que devolverá listPostauth (semilla para tests del scheduler).
     * listPostauth aplica filtros de `username`, `reply` y `sinceAuthdate`/`untilAuthdate`.
     * Default: [].
     */
    authEvents?: AuthEventRow[];
    /**
     * radius-session-autocure (REQ-CURE-3/D9) — sessionIds para los que cureSession debe
     * responder 404 (OrchestratorRejectedError) en vez del alreadyClosed:true por defecto:
     * modela `find_any_by_id` sin match (ni abierta ni cerrada). Default: [].
     */
    cureNotFoundSessionIds?: string[];
    /** Status del CoA que cureSession reporta por defecto ('ack' | 'timeout' | 'nak'). Default 'ack'. */
    cureCoaStatus?: string;
  }) {
    this.unreachable = new Set(opts?.unreachable ?? []);
    this.failForPlanCode = new Set(opts?.failForPlanCode ?? []);
    this.rejectPlanCode = new Map((opts?.rejectPlanCode ?? []).map(r => [r.code, r]));
    this.onSyncPlanCb = opts?.onSyncPlan;
    this.assignedIps = [...(opts?.assignedIps ?? [])];
    this.assignedIpsUnreachable = opts?.assignedIpsUnreachable ?? false;
    this.usersInventory = [...(opts?.usersInventory ?? [])];
    this.globalSessionsList = [...(opts?.globalSessions ?? [])];
    this.globalSessionsUnreachable = opts?.globalSessionsUnreachable ?? false;
    this.accountingEvents = [...(opts?.accountingEvents ?? [])];
    this.authEvents = [...(opts?.authEvents ?? [])];
    this.cureNotFoundSessionIds = new Set(opts?.cureNotFoundSessionIds ?? []);
    this.cureCoaStatus = opts?.cureCoaStatus ?? 'ack';
    for (const u of opts?.seed ?? []) {
      this.state.set(u.username, { plan: u.plan ?? '', suspended: u.suspended ?? false });
      if (u.sessions) this.sessions.set(u.username, u.sessions);
    }
  }

  private guardUser(username: string): void {
    if (this.unreachable.has(username)) throw new OrchestratorUnreachableError('in-memory');
  }

  private guardPlan(code: string): void {
    if (this.failForPlanCode.has(code)) throw new OrchestratorUnreachableError('in-memory');
    const rejection = this.rejectPlanCode.get(code);
    if (rejection) {
      throw new OrchestratorRejectedError(
        rejection.status,
        { detail: rejection.detail ?? `plan ${code} rejected` },
      );
    }
  }

  private upsert(username: string): UserState {
    let s = this.state.get(username);
    if (!s) {
      s = { plan: '', suspended: false };
      this.state.set(username, s);
    }
    return s;
  }

  async createUser(input: CreateRadiusUserInput): Promise<void> {
    this.guardUser(input.username);
    // Usuario duplicado → el orchestrator real devuelve 409 → OrchestratorRejectedError.
    if (this.createdUsers.has(input.username)) {
      throw new OrchestratorRejectedError(409, { detail: `user ${input.username} already exists` });
    }
    const record: CreatedRadiusUser = {
      username: input.username,
      password: input.password,
      plan: input.plan,
      framedIp: input.framedIp ?? null,
    };
    this.createdUsers.set(input.username, record);
    this.calls.push({ op: 'createUser', username: input.username, arg: record });
    this.upsert(input.username).plan = input.plan;
  }

  async listUsers(): Promise<RadiusUserInventoryItem[]> {
    return this.usersInventory.map(u => ({ ...u }));
  }

  async changePlan(username: string, plan: string, opts?: ChangePlanOptions): Promise<void> {
    this.guardUser(username);
    this.calls.push({ op: 'changePlan', username, arg: { plan, ...opts } });
    this.upsert(username).plan = plan;
  }

  async changePassword(username: string, password: string): Promise<void> {
    this.guardUser(username);
    this.calls.push({ op: 'changePassword', username, arg: { password } });
    this.upsert(username).password = password;
  }

  async changeFramedIp(username: string, framedIp: string | null): Promise<void> {
    this.guardUser(username);
    // El intento se registra ANTES del rechazo: la petición SÍ llegó al orchestrator
    // (permite asertar la cantidad de intentos del retry en los tests de colisión).
    this.calls.push({ op: 'changeFramedIp', username, arg: { framedIp } });
    if (framedIp !== null) {
      const owner = this.ipOwners.get(framedIp);
      if (owner !== undefined && owner !== username) {
        // Guard autoritativo del orchestrator real: Framed-IP tomada por OTRO → 409.
        throw new OrchestratorRejectedError(409, {
          detail: `Framed-IP ${framedIp} already assigned to '${owner}' (FramedIpAlreadyAssigned)`,
        });
      }
    }
    // Libera la IP anterior escrita por ESTE username (el radreply real se sobreescribe).
    const prev = this.state.get(username)?.framedIp;
    if (prev && this.ipOwners.get(prev) === username) {
      this.ipOwners.delete(prev);
      const i = this.assignedIps.indexOf(prev);
      if (i !== -1) this.assignedIps.splice(i, 1);
    }
    if (framedIp !== null) {
      this.ipOwners.set(framedIp, username);
      if (!this.assignedIps.includes(framedIp)) this.assignedIps.push(framedIp);
    }
    this.upsert(username).framedIp = framedIp;
  }

  async suspend(username: string, opts?: SuspendOptions): Promise<void> {
    this.guardUser(username);
    this.calls.push({ op: 'suspend', username, arg: opts });
    this.upsert(username).suspended = true;
    if (opts?.disconnectActiveSessions) this.sessions.set(username, []);
  }

  async reactivate(username: string): Promise<void> {
    this.guardUser(username);
    this.calls.push({ op: 'reactivate', username });
    this.upsert(username).suspended = false;
  }

  async listSessions(username: string): Promise<OrchestratorSession[]> {
    this.guardUser(username);
    // radius-session-autocure: copia defensiva — cureSession() hace splice() sobre el array
    // INTERNO al cerrar una sesión; devolver la referencia viva rompía a los callers que iteran
    // el resultado de listSessions() mientras curan cada sesión (mutar-durante-iterar).
    return [...(this.sessions.get(username) ?? [])];
  }

  async disconnectSessions(username: string): Promise<void> {
    this.guardUser(username);
    this.calls.push({ op: 'disconnectSessions', username });
    this.sessions.set(username, []);
  }

  async deleteUser(username: string): Promise<void> {
    this.guardUser(username);
    this.calls.push({ op: 'deleteUser', username });
    this.state.delete(username);
    this.sessions.delete(username);
    this.createdUsers.delete(username);
  }

  async syncPlan(code: string, downloadKbps: number, uploadKbps: number, pool?: string | null): Promise<void> {
    this.guardPlan(code);
    this.onSyncPlanCb?.();
    this.planCalls.push({ op: 'syncPlan', code, downloadKbps, uploadKbps, pool });
  }

  async deletePlan(code: string): Promise<void> {
    this.guardPlan(code);
    this.planCalls.push({ op: 'deletePlan', code });
  }

  async listAssignedIps(): Promise<string[]> {
    if (this.assignedIpsUnreachable) throw new OrchestratorUnreachableError('in-memory');
    return [...this.assignedIps];
  }

  async listActiveSessions(offset = 0, limit = 10000): Promise<OrchestratorSession[]> {
    if (this.globalSessionsUnreachable) throw new OrchestratorUnreachableError('in-memory');
    return [...this.globalSessionsList].slice(offset, offset + limit);
  }

  /**
   * Implementación in-memory de listAccounting.
   * - Aplica filtros `username`, `sinceUpdate`/`untilUpdate` (FIX2) si se sembraron datos.
   * - Respeta `page` y `pageSize` para paginación.
   * - No hace llamadas HTTP.
   *
   * FIX2: filtra por lastUpdate (acctupdatetime) en lugar de startedAt para que sesiones
   * con startedAt antiguo pero lastUpdate reciente (recién cerradas) entren en la ventana.
   */
  async listAccounting(filters: ListAccountingFilters): Promise<AccountingPage> {
    let items = [...this.accountingEvents];

    // Filtros simples que el orchestrator apoyaría
    if (filters.username) {
      items = items.filter((e) => e.username === filters.username);
    }
    // FIX2: filtrar por lastUpdate (acctupdatetime), no por startedAt
    if (filters.sinceUpdate) {
      const since = filters.sinceUpdate;
      items = items.filter((e) => {
        const ts = e.lastUpdate ?? e.startedAt; // fallback si lastUpdate no está seteado
        return ts >= since;
      });
    }
    if (filters.untilUpdate) {
      const until = filters.untilUpdate;
      items = items.filter((e) => {
        const ts = e.lastUpdate ?? e.startedAt;
        return ts <= until;
      });
    }

    const page     = filters.page     ?? 1;
    const pageSize = filters.pageSize ?? 500;
    const skip     = (page - 1) * pageSize;
    const pageItems = items.slice(skip, skip + pageSize);
    const hasMore   = skip + pageSize < items.length;

    return {
      items:    pageItems,
      page,
      pageSize,
      nextPage: hasMore ? page + 1 : null,
    };
  }

  /**
   * Implementación in-memory de listPostauth (espejo de listAccounting).
   * - Aplica filtros `username`, `reply`, `sinceAuthdate`/`untilAuthdate` si se sembraron datos.
   * - Respeta `page` y `pageSize` para paginación.
   */
  async listPostauth(filters: ListPostauthFilters): Promise<PostauthPage> {
    let items = [...this.authEvents];

    if (filters.username) {
      items = items.filter((e) => e.username === filters.username);
    }
    if (filters.reply) {
      items = items.filter((e) => e.reply === filters.reply);
    }
    if (filters.sinceAuthdate) {
      const since = filters.sinceAuthdate;
      items = items.filter((e) => e.authdate >= since);
    }
    if (filters.untilAuthdate) {
      const until = filters.untilAuthdate;
      items = items.filter((e) => e.authdate <= until);
    }

    const page     = filters.page     ?? 1;
    const pageSize = filters.pageSize ?? 500;
    const skip     = (page - 1) * pageSize;
    const pageItems = items.slice(skip, skip + pageSize);
    const hasMore   = skip + pageSize < items.length;

    return {
      items:    pageItems,
      page,
      pageSize,
      nextPage: hasMore ? page + 1 : null,
    };
  }

  /**
   * radius-session-autocure (REQ-CURE-3/D9) — modela la semántica REAL del endpoint cure:
   *  - sessionId en `cureNotFoundSessionIds` → OrchestratorRejectedError(404) (find_any_by_id sin match).
   *  - sessionId presente en las sesiones ABIERTAS del usuario → la cierra (splice del array
   *    `sessions`, como el UPDATE real) y devuelve cured:true.
   *  - sessionId AUSENTE de las sesiones abiertas (ya curada antes / el cron ganó la carrera) →
   *    already_closed:true, NO throw (lección del fake de changeFramedIp, design D9).
   *  - `unreachable` (mismo set que el resto de las ops) → OrchestratorUnreachableError.
   */
  async cureSession(username: string, sessionId: string): Promise<CureSessionResult> {
    this.guardUser(username);
    this.cureCalls.push({ username, sessionId });
    if (this.cureNotFoundSessionIds.has(sessionId)) {
      throw new OrchestratorRejectedError(404, { detail: `session ${sessionId} not found` });
    }
    const list = this.sessions.get(username) ?? [];
    const idx = list.findIndex((s) => s.sessionId === sessionId);
    if (idx === -1) {
      return { cured: false, alreadyClosed: true, closedAt: null, coa: [{ nasIp: '', status: this.cureCoaStatus, detail: null }] };
    }
    const [closed] = list.splice(idx, 1);
    this.sessions.set(username, list);
    return {
      cured: true,
      alreadyClosed: false,
      closedAt: new Date().toISOString(),
      coa: [{ nasIp: closed?.nasIp ?? '', status: this.cureCoaStatus, detail: null }],
    };
  }

  // ── Helpers de test ────────────────────────────────────────────────────────
  /** El snapshot del `createUser` registrado para `username` (o undefined si no se creó). */
  createdUser(username: string): CreatedRadiusUser | undefined {
    return this.createdUsers.get(username);
  }
  /** Las ops `createUser` registradas para `username` (vacío si no hubo alta RADIUS). */
  opsForCreate(username: string): string[] {
    return this.calls.filter((c) => c.username === username && c.op === 'createUser').map((c) => c.op);
  }
  planOf(username: string): string | undefined {
    return this.state.get(username)?.plan;
  }
  passwordOf(username: string): string | undefined {
    return this.state.get(username)?.password;
  }
  framedIpOf(username: string): string | null | undefined {
    return this.state.get(username)?.framedIp;
  }
  isSuspended(username: string): boolean {
    return this.state.get(username)?.suspended ?? false;
  }
  opsFor(username: string): string[] {
    return this.calls.filter((c) => c.username === username).map((c) => c.op);
  }
}
