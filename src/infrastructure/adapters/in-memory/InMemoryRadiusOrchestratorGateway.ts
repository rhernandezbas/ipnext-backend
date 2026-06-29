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
  RadiusIpPool,
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
  /** IPs asignadas en el RADIUS (radreply Framed-IP) que devuelve listAssignedIps. */
  private readonly assignedIps: string[];
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
  /** pppoe-pool-ip: pools del radippool que devuelve listPools (GET /pools). Sembrable. */
  private readonly pools: RadiusIpPool[];
  /** pppoe-pool-ip: si true, listPools lanza OrchestratorUnreachableError (simula orchestrator caído). */
  private readonly poolsUnreachable: boolean;

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
    /** pppoe-pool-ip: pools del radippool que devolverá listPools (GET /pools). Default: []. */
    pools?: RadiusIpPool[];
    /** pppoe-pool-ip: si true, listPools lanza OrchestratorUnreachableError. Default: false. */
    poolsUnreachable?: boolean;
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
    this.pools = [...(opts?.pools ?? [])];
    this.poolsUnreachable = opts?.poolsUnreachable ?? false;
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
    this.calls.push({ op: 'changeFramedIp', username, arg: { framedIp } });
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
    return this.sessions.get(username) ?? [];
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

  async listPools(): Promise<RadiusIpPool[]> {
    if (this.poolsUnreachable) throw new OrchestratorUnreachableError('in-memory');
    return this.pools.map(p => ({ ...p }));
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
