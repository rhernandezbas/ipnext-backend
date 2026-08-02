import { randomUUID } from 'crypto';
import type { PortalPushPreference } from '@domain/entities/portalPush';
import type {
  PortalPushPreferenceRepository,
  UpdatePortalPushPreferenceInput,
} from '@domain/ports/PortalPushPreferenceRepository';

/** InMemoryPortalPushPreferenceRepository — test seam (portal-push-notifications). */
export class InMemoryPortalPushPreferenceRepository implements PortalPushPreferenceRepository {
  private readonly store: PortalPushPreference[] = [];

  private create(accountId: string): PortalPushPreference {
    const now = new Date().toISOString();
    const row: PortalPushPreference = {
      id: randomUUID(),
      accountId,
      serviceAlerts: true,
      promos: false,
      promosOptInAt: null,
      promosOptInAppVersion: null,
      updatedAt: now,
    };
    this.store.push(row);
    return row;
  }

  async getOrCreate(accountId: string): Promise<PortalPushPreference> {
    const existing = this.store.find((p) => p.accountId === accountId);
    if (existing) return { ...existing };
    return { ...this.create(accountId) };
  }

  async update(accountId: string, patch: UpdatePortalPushPreferenceInput): Promise<PortalPushPreference> {
    let row = this.store.find((p) => p.accountId === accountId);
    if (!row) row = this.create(accountId);
    if (patch.serviceAlerts !== undefined) row.serviceAlerts = patch.serviceAlerts;
    if (patch.promos !== undefined) row.promos = patch.promos;
    if (patch.promosOptInAt !== undefined) row.promosOptInAt = patch.promosOptInAt.toISOString();
    if (patch.promosOptInAppVersion !== undefined) row.promosOptInAppVersion = patch.promosOptInAppVersion;
    row.updatedAt = new Date().toISOString();
    return { ...row };
  }
}
