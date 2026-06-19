import {
  ActiveSession,
  NasTarget,
  PppoeRouterGateway,
  RouterSecret,
  SecretInput,
} from '@domain/ports/PppoeRouterGateway';
import { RouterUnreachableError } from '@domain/errors/pppoe';

/**
 * InMemoryRouterGateway — fake del PppoeRouterGateway para tests (sin router real).
 * Store de secrets/sesiones por `ipAddress`. `unreachable` simula routers caídos →
 * RouterUnreachableError (para testear la consistencia DB↔router de los use cases).
 */
export class InMemoryRouterGateway implements PppoeRouterGateway {
  private readonly secrets = new Map<string, RouterSecret[]>();
  private readonly sessions = new Map<string, ActiveSession[]>();
  private readonly unreachable: Set<string>;

  constructor(opts?: { unreachable?: string[] }) {
    this.unreachable = new Set(opts?.unreachable ?? []);
  }

  private guard(nas: NasTarget): void {
    if (this.unreachable.has(nas.ipAddress)) throw new RouterUnreachableError(nas.ipAddress);
  }

  /** Test seam: siembra una sesión activa en un router (para verificar el kick de Fase C). */
  seedSession(ipAddress: string, session: ActiveSession): void {
    const list = this.sessions.get(ipAddress) ?? [];
    list.push({ ...session });
    this.sessions.set(ipAddress, list);
  }

  private bucket(nas: NasTarget): RouterSecret[] {
    let b = this.secrets.get(nas.ipAddress);
    if (!b) {
      b = [];
      this.secrets.set(nas.ipAddress, b);
    }
    return b;
  }

  async listSecrets(nas: NasTarget): Promise<RouterSecret[]> {
    this.guard(nas);
    return this.bucket(nas).map(s => ({ ...s }));
  }

  async createSecret(nas: NasTarget, input: SecretInput): Promise<void> {
    this.guard(nas);
    const b = this.bucket(nas);
    const secret: RouterSecret = {
      username: input.username,
      profile: input.profile ?? null,
      remoteAddress: input.remoteAddress ?? null,
      disabled: input.disabled ?? false,
    };
    const existing = b.find(s => s.username === input.username);
    if (existing) {
      Object.assign(existing, secret); // idempotente (create-or-set, como RouterOS)
    } else {
      b.push(secret);
    }
  }

  async updateSecret(nas: NasTarget, username: string, patch: Partial<SecretInput>): Promise<void> {
    this.guard(nas);
    const s = this.bucket(nas).find(x => x.username === username);
    if (!s) return;
    if (patch.profile !== undefined) s.profile = patch.profile ?? null;
    if (patch.remoteAddress !== undefined) s.remoteAddress = patch.remoteAddress ?? null;
    if (patch.disabled !== undefined) s.disabled = patch.disabled ?? false;
    // `password` no se refleja en RouterSecret (nunca se lee del router)
  }

  async removeSecret(nas: NasTarget, username: string): Promise<void> {
    this.guard(nas);
    const b = this.bucket(nas);
    const i = b.findIndex(s => s.username === username);
    if (i >= 0) b.splice(i, 1);
  }

  async listAssignedIps(nas: NasTarget): Promise<string[]> {
    this.guard(nas);
    return this.bucket(nas)
      .map(s => s.remoteAddress)
      .filter((addr): addr is string => !!addr);
  }

  async listActiveSessions(nas: NasTarget): Promise<ActiveSession[]> {
    this.guard(nas);
    return (this.sessions.get(nas.ipAddress) ?? []).map(s => ({ ...s }));
  }

  async removeActiveSession(nas: NasTarget, username: string): Promise<void> {
    this.guard(nas);
    const list = this.sessions.get(nas.ipAddress);
    if (!list) return;
    const i = list.findIndex(s => s.username === username);
    if (i >= 0) list.splice(i, 1);
  }
}
