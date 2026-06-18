import {
  RadiusOrchestratorGateway,
  OrchestratorSession,
  ChangePlanOptions,
  SuspendOptions,
} from '@domain/ports/RadiusOrchestratorGateway';
import { OrchestratorUnreachableError } from '@domain/errors/pppoe';

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

interface CallLog {
  op: 'changePlan' | 'suspend' | 'reactivate' | 'disconnectSessions';
  username: string;
  arg?: unknown;
}

/**
 * InMemoryRadiusOrchestratorGateway — doble de test del orchestrator. Modela el estado por-usuario
 * (plan + suspended + sesiones) y registra las llamadas (`calls`) para aserciones. `unreachable`
 * simula el orchestrator caído (→ `OrchestratorUnreachableError`, igual que el HTTP real).
 */
export class InMemoryRadiusOrchestratorGateway implements RadiusOrchestratorGateway {
  private readonly state = new Map<string, UserState>();
  private readonly sessions = new Map<string, OrchestratorSession[]>();
  private readonly unreachable: Set<string>;
  public readonly calls: CallLog[] = [];

  constructor(opts?: { unreachable?: string[]; seed?: InMemoryOrchestratorSeed[] }) {
    this.unreachable = new Set(opts?.unreachable ?? []);
    for (const u of opts?.seed ?? []) {
      this.state.set(u.username, { plan: u.plan ?? '', suspended: u.suspended ?? false });
      if (u.sessions) this.sessions.set(u.username, u.sessions);
    }
  }

  private guard(username: string): void {
    if (this.unreachable.has(username)) throw new OrchestratorUnreachableError('in-memory');
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
    this.guard(username);
    this.calls.push({ op: 'changePlan', username, arg: { plan, ...opts } });
    this.upsert(username).plan = plan;
  }

  async suspend(username: string, opts?: SuspendOptions): Promise<void> {
    this.guard(username);
    this.calls.push({ op: 'suspend', username, arg: opts });
    this.upsert(username).suspended = true;
    if (opts?.disconnectActiveSessions) this.sessions.set(username, []);
  }

  async reactivate(username: string): Promise<void> {
    this.guard(username);
    this.calls.push({ op: 'reactivate', username });
    this.upsert(username).suspended = false;
  }

  async listSessions(username: string): Promise<OrchestratorSession[]> {
    this.guard(username);
    return this.sessions.get(username) ?? [];
  }

  async disconnectSessions(username: string): Promise<void> {
    this.guard(username);
    this.calls.push({ op: 'disconnectSessions', username });
    this.sessions.set(username, []);
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
