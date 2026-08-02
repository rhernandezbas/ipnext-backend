import { prisma } from '../../database/prisma';
import type { PortalPushPreference } from '@domain/entities/portalPush';
import type {
  PortalPushPreferenceRepository,
  UpdatePortalPushPreferenceInput,
} from '@domain/ports/PortalPushPreferenceRepository';

interface PortalPushPreferenceRow {
  id: string;
  accountId: string;
  serviceAlerts: boolean;
  promos: boolean;
  promosOptInAt: Date | null;
  promosOptInAppVersion: string | null;
  updatedAt: Date;
}

function toEntity(row: PortalPushPreferenceRow): PortalPushPreference {
  return {
    id: row.id,
    accountId: row.accountId,
    serviceAlerts: row.serviceAlerts,
    promos: row.promos,
    promosOptInAt: row.promosOptInAt ? row.promosOptInAt.toISOString() : null,
    promosOptInAppVersion: row.promosOptInAppVersion,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PrismaPortalPushPreferenceRepository implements PortalPushPreferenceRepository {
  /** Upsert atómico — `create: {accountId}` alcanza: el schema aplica los defaults
   *  (serviceAlerts=true, promos=false) sin que este adapter los repita. */
  async getOrCreate(accountId: string): Promise<PortalPushPreference> {
    const row = await prisma.portalPushPreference.upsert({
      where: { accountId },
      update: {},
      create: { accountId },
    });
    return toEntity(row as unknown as PortalPushPreferenceRow);
  }

  async update(accountId: string, patch: UpdatePortalPushPreferenceInput): Promise<PortalPushPreference> {
    const data: Record<string, unknown> = {};
    if (patch.serviceAlerts !== undefined) data['serviceAlerts'] = patch.serviceAlerts;
    if (patch.promos !== undefined) data['promos'] = patch.promos;
    if (patch.promosOptInAt !== undefined) data['promosOptInAt'] = patch.promosOptInAt;
    if (patch.promosOptInAppVersion !== undefined) data['promosOptInAppVersion'] = patch.promosOptInAppVersion;

    const row = await prisma.portalPushPreference.upsert({
      where: { accountId },
      update: data,
      create: { accountId, ...data },
    });
    return toEntity(row as unknown as PortalPushPreferenceRow);
  }
}
