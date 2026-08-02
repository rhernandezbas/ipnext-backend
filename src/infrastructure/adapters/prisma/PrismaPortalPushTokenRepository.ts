import { prisma } from '../../database/prisma';
import type { PortalPushToken } from '@domain/entities/portalPush';
import type {
  PortalPushTokenRepository,
  UpsertPushTokenInput,
  PushServiceAlertTarget,
} from '@domain/ports/PortalPushTokenRepository';

interface PortalPushTokenRow {
  id: string;
  accountId: string;
  token: string;
  platform: string;
  deviceLabel: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  invalidAt: Date | null;
}

function toEntity(row: PortalPushTokenRow): PortalPushToken {
  return {
    id: row.id,
    accountId: row.accountId,
    token: row.token,
    platform: row.platform === 'ios' ? 'ios' : 'android',
    deviceLabel: row.deviceLabel,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    invalidAt: row.invalidAt ? row.invalidAt.toISOString() : null,
  };
}

export class PrismaPortalPushTokenRepository implements PortalPushTokenRepository {
  /**
   * Upsert por `token` (`@unique`) — el WHERE ataca la columna única, no
   * (accountId, token): esta es la operación que REASIGNA un token de una
   * cuenta a otra (ver el docblock del port). `update` pisa accountId,
   * platform, deviceLabel, refresca `lastSeenAt` y limpia `invalidAt` — un
   * token que vuelve a registrarse está vivo de nuevo, sin importar de quién era antes.
   */
  async upsertByToken(input: UpsertPushTokenInput): Promise<PortalPushToken> {
    const row = await prisma.portalPushToken.upsert({
      where: { token: input.token },
      create: {
        accountId: input.accountId,
        token: input.token,
        platform: input.platform,
        deviceLabel: input.deviceLabel ?? null,
      },
      update: {
        accountId: input.accountId,
        platform: input.platform,
        deviceLabel: input.deviceLabel ?? null,
        lastSeenAt: new Date(),
        invalidAt: null,
      },
    });
    return toEntity(row as unknown as PortalPushTokenRow);
  }

  /** `deleteMany` con AMBAS condiciones — cero riesgo de borrar el token de otra cuenta. */
  async deleteForAccount(accountId: string, token: string): Promise<boolean> {
    const result = await prisma.portalPushToken.deleteMany({ where: { accountId, token } });
    return result.count > 0;
  }

  async listServiceAlertTargets(clientIds?: string[]): Promise<PushServiceAlertTarget[]> {
    if (clientIds && clientIds.length === 0) return [];
    const accounts = await prisma.portalAccount.findMany({
      where: {
        pushPreference: { serviceAlerts: true },
        pushTokens: { some: { invalidAt: null } },
        ...(clientIds ? { clientId: { in: clientIds } } : {}),
      },
      select: {
        id: true,
        clientId: true,
        pushTokens: { where: { invalidAt: null }, select: { token: true } },
      },
    });
    return accounts.map((a) => ({
      accountId: a.id,
      clientId: a.clientId,
      tokens: a.pushTokens.map((t) => t.token),
    }));
  }

  async markInvalid(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    await prisma.portalPushToken.updateMany({
      where: { token: { in: tokens } },
      data: { invalidAt: new Date() },
    });
  }
}
