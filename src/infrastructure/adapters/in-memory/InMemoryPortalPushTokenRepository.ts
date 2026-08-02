import { randomUUID } from 'crypto';
import type { PortalPushToken } from '@domain/entities/portalPush';
import type {
  PortalPushTokenRepository,
  UpsertPushTokenInput,
  PushServiceAlertTarget,
} from '@domain/ports/PortalPushTokenRepository';

/**
 * InMemoryPortalPushTokenRepository — test seam (portal-push-notifications).
 *
 * `serviceAlertsByAccount` — inyectable en el constructor, es el fake de
 * "¿esta cuenta tiene `serviceAlerts=true`?" que `listServiceAlertTargets`
 * necesita. En prod esto sale de un JOIN con `PortalPushPreference`; acá,
 * para no acoplar dos in-memory repos entre sí, el caller del test decide qué
 * cuentas tienen el flag prendido (mismo criterio narrow que
 * `FakeSegmentChecker` en `portalPromos.routes.test.ts`).
 */
export class InMemoryPortalPushTokenRepository implements PortalPushTokenRepository {
  private readonly store: PortalPushToken[] = [];
  /** accountId -> clientId, necesario para `listServiceAlertTargets`. */
  readonly clientIdByAccount = new Map<string, string>();
  /** accountId -> serviceAlerts flag, ver docblock de la clase. */
  readonly serviceAlertsByAccount = new Map<string, boolean>();

  /** Test seam — registra la cuenta (clientId + serviceAlerts) sin pasar por el port. */
  seedAccount(accountId: string, clientId: string, serviceAlerts: boolean): void {
    this.clientIdByAccount.set(accountId, clientId);
    this.serviceAlertsByAccount.set(accountId, serviceAlerts);
  }

  async upsertByToken(input: UpsertPushTokenInput): Promise<PortalPushToken> {
    const now = new Date().toISOString();
    const existing = this.store.find((t) => t.token === input.token);
    if (existing) {
      existing.accountId = input.accountId;
      existing.platform = input.platform;
      existing.deviceLabel = input.deviceLabel ?? null;
      existing.lastSeenAt = now;
      existing.invalidAt = null;
      return { ...existing };
    }
    const row: PortalPushToken = {
      id: randomUUID(),
      accountId: input.accountId,
      token: input.token,
      platform: input.platform,
      deviceLabel: input.deviceLabel ?? null,
      createdAt: now,
      lastSeenAt: now,
      invalidAt: null,
    };
    this.store.push(row);
    return { ...row };
  }

  async deleteForAccount(accountId: string, token: string): Promise<boolean> {
    const idx = this.store.findIndex((t) => t.accountId === accountId && t.token === token);
    if (idx < 0) return false;
    this.store.splice(idx, 1);
    return true;
  }

  async listServiceAlertTargets(clientIds?: string[]): Promise<PushServiceAlertTarget[]> {
    if (clientIds && clientIds.length === 0) return [];
    const clientIdSet = clientIds ? new Set(clientIds) : null;

    const accountIds = new Set(this.store.map((t) => t.accountId));
    const targets: PushServiceAlertTarget[] = [];
    for (const accountId of accountIds) {
      if (this.serviceAlertsByAccount.get(accountId) !== true) continue;
      const clientId = this.clientIdByAccount.get(accountId);
      if (!clientId) continue;
      if (clientIdSet && !clientIdSet.has(clientId)) continue;
      const liveTokens = this.store.filter((t) => t.accountId === accountId && t.invalidAt === null).map((t) => t.token);
      if (liveTokens.length === 0) continue;
      targets.push({ accountId, clientId, tokens: liveTokens });
    }
    return targets;
  }

  async markInvalid(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    const now = new Date().toISOString();
    const set = new Set(tokens);
    for (const row of this.store) {
      if (set.has(row.token)) row.invalidAt = now;
    }
  }

  /** Test seam — lee el estado crudo de un token (para asserts). */
  findByToken(token: string): PortalPushToken | undefined {
    const row = this.store.find((t) => t.token === token);
    return row ? { ...row } : undefined;
  }
}
