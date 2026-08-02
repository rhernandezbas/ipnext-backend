import { prisma } from '../../database/prisma';
import type { PortalPushToken } from '@domain/entities/portalPush';
import type {
  PortalPushTokenRepository,
  UpsertPushTokenInput,
  PushServiceAlertTarget,
  UpdatePortalPushTokenPreferenceInput,
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
  serviceAlerts: boolean;
  promos: boolean;
  promosOptInAt: Date | null;
  promosOptInAppVersion: string | null;
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
    serviceAlerts: row.serviceAlerts,
    promos: row.promos,
    promosOptInAt: row.promosOptInAt ? row.promosOptInAt.toISOString() : null,
    promosOptInAppVersion: row.promosOptInAppVersion,
  };
}

export class PrismaPortalPushTokenRepository implements PortalPushTokenRepository {
  /**
   * Upsert por `token` (`@unique`) — el WHERE ataca la columna única, no
   * (accountId, token): esta es la operación que REASIGNA un token de una
   * cuenta a otra (ver el docblock del port). `update` pisa accountId,
   * platform, deviceLabel, refresca `lastSeenAt` y limpia `invalidAt` — un
   * token que vuelve a registrarse está vivo de nuevo, sin importar de quién
   * era antes. push-per-device — `serviceAlerts`/`promos`/`promosOptInAt`/
   * `promosOptInAppVersion` NO están en el `update`: un re-registro NUNCA
   * resetea las preferencias del dispositivo (el `create` sí las deja caer a
   * los defaults del schema, `serviceAlerts=true`/`promos=false`).
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

  /**
   * push-per-device — filtro POR TOKEN (`serviceAlerts: true`, `invalidAt:
   * null`), no un JOIN contra `PortalPushPreference` (huérfana, ver su
   * docblock). Una cuenta con 2 tokens, uno silenciado, matchea igual — pero
   * `pushTokens` (el `select` de abajo) trae SOLO el token calificado.
   */
  async listServiceAlertTargets(clientIds?: string[]): Promise<PushServiceAlertTarget[]> {
    if (clientIds && clientIds.length === 0) return [];
    const accounts = await prisma.portalAccount.findMany({
      where: {
        pushTokens: { some: { invalidAt: null, serviceAlerts: true } },
        ...(clientIds ? { clientId: { in: clientIds } } : {}),
      },
      select: {
        id: true,
        clientId: true,
        pushTokens: { where: { invalidAt: null, serviceAlerts: true }, select: { token: true } },
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

  /** Ownership check estructural — WHERE ataca (accountId, token), nunca solo `token`. */
  async findForAccount(accountId: string, token: string): Promise<PortalPushToken | null> {
    const row = await prisma.portalPushToken.findFirst({ where: { accountId, token } });
    return row ? toEntity(row as unknown as PortalPushTokenRow) : null;
  }

  /**
   * `updateMany` con AMBAS condiciones (accountId + token) — mismo patrón
   * anti-IDOR que `deleteForAccount`: si `count === 0` (no existe o es de
   * otra cuenta) devuelve `null` sin re-leer nada. Si escribió, re-lee la fila
   * (Prisma `updateMany` no devuelve el registro actualizado).
   */
  async updatePreferences(
    accountId: string,
    token: string,
    patch: UpdatePortalPushTokenPreferenceInput,
  ): Promise<PortalPushToken | null> {
    const data: Record<string, unknown> = {};
    if (patch.serviceAlerts !== undefined) data['serviceAlerts'] = patch.serviceAlerts;
    if (patch.promos !== undefined) data['promos'] = patch.promos;
    if (patch.promosOptInAt !== undefined) data['promosOptInAt'] = patch.promosOptInAt;
    if (patch.promosOptInAppVersion !== undefined) data['promosOptInAppVersion'] = patch.promosOptInAppVersion;

    const result = await prisma.portalPushToken.updateMany({ where: { accountId, token }, data });
    if (result.count === 0) return null;
    return this.findForAccount(accountId, token);
  }
}
