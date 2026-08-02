import { z } from 'zod';
import type { PortalPushToken } from '@domain/entities/portalPush';

/** `POST /api/portal/push/register` — validación de FORMA únicamente. */
export const RegisterPortalPushTokenSchema = z
  .object({
    token: z.string().trim().min(1),
    platform: z.enum(['android', 'ios']),
    deviceLabel: z.string().trim().min(1).max(200).nullish(),
  })
  .strict();

export type RegisterPortalPushTokenBody = z.infer<typeof RegisterPortalPushTokenSchema>;

/** `DELETE /api/portal/push/register`. */
export const UnregisterPortalPushTokenSchema = z
  .object({
    token: z.string().trim().min(1),
  })
  .strict();

export type UnregisterPortalPushTokenBody = z.infer<typeof UnregisterPortalPushTokenSchema>;

/**
 * push-per-device — `GET /api/portal/push/preferences?token=`. `token` viaja
 * por QUERY (no hay body en un GET) — ausente/vacío es 400 `VALIDATION_ERROR`,
 * nunca un 404 silencioso (distinto de "el token no pertenece a la cuenta",
 * que SÍ es 404 — ver el route handler).
 */
export const GetPortalPushPreferencesQuerySchema = z
  .object({
    token: z.string().trim().min(1),
  })
  .strict();

export type GetPortalPushPreferencesQuery = z.infer<typeof GetPortalPushPreferencesQuerySchema>;

/**
 * `PUT /api/portal/push/preferences` — patch PARCIAL: `undefined` (key
 * ausente) = no tocar, mismo contrato que el resto de los patches del portal
 * (`UpdatePortalPromoData`, etc). `.strict()` — mismo criterio que
 * `SendPortalTicketMessageSchema`: campos desconocidos son 400, no ruido
 * ignorado en silencio.
 *
 * push-per-device — `token` es OBLIGATORIO (identifica EL dispositivo cuyas
 * preferencias se tocan; ya no existe "la preferencia de la cuenta").
 */
export const UpdatePortalPushPreferencesSchema = z
  .object({
    token: z.string().trim().min(1),
    serviceAlerts: z.boolean().optional(),
    promos: z.boolean().optional(),
  })
  .strict();

export type UpdatePortalPushPreferencesBody = z.infer<typeof UpdatePortalPushPreferencesSchema>;

/**
 * DTO client-facing — deliberadamente SIN `promosOptInAt`/
 * `promosOptInAppVersion` (auditoría interna, sin valor para el cliente) ni
 * `id`/`accountId`/`token` (el caller ya sabe qué token pidió).
 */
export interface PortalPushPreferenceDto {
  serviceAlerts: boolean;
  promos: boolean;
}

export function toPortalPushPreferenceDto(token: Pick<PortalPushToken, 'serviceAlerts' | 'promos'>): PortalPushPreferenceDto {
  return { serviceAlerts: token.serviceAlerts, promos: token.promos };
}
