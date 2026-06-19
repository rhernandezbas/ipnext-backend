import {
  RadiusOrchestratorGateway,
  OrchestratorSession,
  ChangePlanOptions,
  SuspendOptions,
} from '@domain/ports/RadiusOrchestratorGateway';
import { OrchestratorUnreachableError, OrchestratorRejectedError } from '@domain/errors/pppoe';

interface UserState {
  plan: string;
  suspended: boolean;
}

export interface InMemoryOrchestratorSeed {
  username: string;
  plan?: string;
  suspended?: boolean;
  sessions?: OrchestratorSession[];
}

interface UserCallLog {
  op: 'changePlan' | 'suspend' | 'reactivate' | 'disconnectSessions';
  username: string;
  arg?: unknown;
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
  private readonly unreachable: Set<string>;
  private readonly failForPlanCode: Set<string>;
  private readonly rejectPlanCode: Map<string, PlanRejectionSeed>;
  private readonly onSyncPlanCb: (() => void) | undefined;

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
  }) {
    this.unreachable = new Set(opts?.unreachable ?? []);
    this.failForPlanCode = new Set(opts?.failForPlanCode ?? []);
    this.rejectPlanCode = new Map((opts?.rejectPlanCode ?? []).map(r => [r.code, r]));
    this.onSyncPlanCb = opts?.onSyncPlan;
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

  async changePlan(username: string, plan: string, opts?: ChangePlanOptions): Promise<void> {
    this.guardUser(username);
    this.calls.push({ op: 'changePlan', username, arg: { plan, ...opts } });
    this.upsert(username).plan = plan;
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

  async syncPlan(code: string, downloadKbps: number, uploadKbps: number, pool?: string | null): Promise<void> {
    this.guardPlan(code);
    this.onSyncPlanCb?.();
    this.planCalls.push({ op: 'syncPlan', code, downloadKbps, uploadKbps, pool });
  }

  async deletePlan(code: string): Promise<void> {
    this.guardPlan(code);
    this.planCalls.push({ op: 'deletePlan', code });
  }

  // ── Helpers de test ────────────────────────────────────────────────────────
  planOf(username: string): string | undefined {
    return this.state.get(username)?.plan;
  }
  isSuspended(username: string): boolean {
    return this.state.get(username)?.suspended ?? false;
  }
  opsFor(username: string): string[] {
    return this.calls.filter((c) => c.username === username).map((c) => c.op);
  }
}
