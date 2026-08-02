import type { PortalPushTokenRepository } from '@domain/ports/PortalPushTokenRepository';

export interface RegisterPortalPushTokenInput {
  token: string;
  platform: 'android' | 'ios';
  deviceLabel?: string | null;
}

/**
 * RegisterPortalPushToken — `POST /api/portal/push/register` (portal-push-notifications).
 *
 * `accountId` SIEMPRE sale del token de sesión (anti-IDOR estructural, mismo
 * criterio que `req.portalClientId` en el resto del portal) — nunca del body.
 *
 * Upsert por `token`: si el token YA estaba registrado bajo OTRA cuenta, esta
 * llamada lo REASIGNA a `accountId` — un teléfono vendido/prestado no puede
 * seguir recibiendo el push del dueño anterior (ver el docblock del port).
 */
export class RegisterPortalPushToken {
  constructor(private readonly tokens: Pick<PortalPushTokenRepository, 'upsertByToken'>) {}

  async execute(accountId: string, input: RegisterPortalPushTokenInput): Promise<void> {
    await this.tokens.upsertByToken({
      accountId,
      token: input.token,
      platform: input.platform,
      deviceLabel: input.deviceLabel ?? null,
    });
  }
}
