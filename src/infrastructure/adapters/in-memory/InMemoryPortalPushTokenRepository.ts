import { randomUUID } from 'crypto';
import type { PortalPushToken } from '@domain/entities/portalPush';
import type {
  PortalPushTokenRepository,
  UpsertPushTokenInput,
  PushServiceAlertTarget,
  UpdatePortalPushTokenPreferenceInput,
} from '@domain/ports/PortalPushTokenRepository';

/**
 * InMemoryPortalPushTokenRepository — test seam (push-per-device).
 *
 * `serviceAlertsByAccount` — inyectable vía `seedAccount`, es un ATAJO de
 * fixture: "todo token de esta cuenta, ya creado o por crearse, tiene
 * `serviceAlerts=X`" — retroactivo (aplica a los tokens YA registrados) y
 * prospectivo (default de los que se registren después). Existe para no
 * romper los fixtures viejos de `SendPushServiceAlert.test.ts` (que
 * pensaban en "serviceAlerts" como un flag de cuenta); el filtro REAL de
 * `listServiceAlertTargets` es por TOKEN (`row.serviceAlerts`), no por este
 * mapa — un test que quiera el caso motivador (2 teléfonos, 1 silenciado)
 * usa `updatePreferences` sobre UN token puntual, el mismo camino que prod.
 */
export class InMemoryPortalPushTokenRepository implements PortalPushTokenRepository {
  private readonly store: PortalPushToken[] = [];
  /** accountId -> clientId, necesario para `listServiceAlertTargets`. */
  readonly clientIdByAccount = new Map<string, string>();
  /** accountId -> default de `serviceAlerts` para tokens de esa cuenta, ver docblock de la clase. */
  readonly serviceAlertsByAccount = new Map<string, boolean>();

  /** Test seam — registra la cuenta (clientId + serviceAlerts) sin pasar por el port. */
  seedAccount(accountId: string, clientId: string, serviceAlerts: boolean): void {
    this.clientIdByAccount.set(accountId, clientId);
    this.serviceAlertsByAccount.set(accountId, serviceAlerts);
    for (const row of this.store) {
      if (row.accountId === accountId) row.serviceAlerts = serviceAlerts;
    }
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
      // push-per-device — las preferencias del dispositivo NO se tocan en un
      // re-registro (mismo criterio que PrismaPortalPushTokenRepository).
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
      serviceAlerts: this.serviceAlertsByAccount.get(input.accountId) ?? true,
      promos: false,
      promosOptInAt: null,
      promosOptInAppVersion: null,
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

  async findForAccount(accountId: string, token: string): Promise<PortalPushToken | null> {
    const row = this.store.find((t) => t.accountId === accountId && t.token === token);
    return row ? { ...row } : null;
  }

  async updatePreferences(
    accountId: string,
    token: string,
    patch: UpdatePortalPushTokenPreferenceInput,
  ): Promise<PortalPushToken | null> {
    const row = this.store.find((t) => t.accountId === accountId && t.token === token);
    if (!row) return null;
    if (patch.serviceAlerts !== undefined) row.serviceAlerts = patch.serviceAlerts;
    if (patch.promos !== undefined) row.promos = patch.promos;
    if (patch.promosOptInAt !== undefined) row.promosOptInAt = patch.promosOptInAt.toISOString();
    if (patch.promosOptInAppVersion !== undefined) row.promosOptInAppVersion = patch.promosOptInAppVersion;
    return { ...row };
  }

  async listServiceAlertTargets(clientIds?: string[]): Promise<PushServiceAlertTarget[]> {
    if (clientIds && clientIds.length === 0) return [];
    const clientIdSet = clientIds ? new Set(clientIds) : null;

    const accountIds = new Set(this.store.map((t) => t.accountId));
    const targets: PushServiceAlertTarget[] = [];
    for (const accountId of accountIds) {
      const clientId = this.clientIdByAccount.get(accountId);
      if (!clientId) continue;
      if (clientIdSet && !clientIdSet.has(clientId)) continue;
      // push-per-device — filtro POR TOKEN: vivo (invalidAt null) Y
      // serviceAlerts=true en ESE token, no un flag de cuenta.
      const liveTokens = this.store
        .filter((t) => t.accountId === accountId && t.invalidAt === null && t.serviceAlerts === true)
        .map((t) => t.token);
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
