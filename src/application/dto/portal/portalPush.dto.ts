import { z } from 'zod';
import type { PortalPushPreference } from '@domain/entities/portalPush';

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
 * `PUT /api/portal/push/preferences` — patch PARCIAL: `undefined` (key
 * ausente) = no tocar, mismo contrato que el resto de los patches del portal
 * (`UpdatePortalPromoData`, etc). `.strict()` — mismo criterio que
 * `SendPortalTicketMessageSchema`: campos desconocidos son 400, no ruido
 * ignorado en silencio.
 */
export const UpdatePortalPushPreferencesSchema = z
  .object({
    serviceAlerts: z.boolean().optional(),
    promos: z.boolean().optional(),
  })
  .strict();

export type UpdatePortalPushPreferencesBody = z.infer<typeof UpdatePortalPushPreferencesSchema>;

/**
 * DTO client-facing — deliberadamente SIN `promosOptInAt`/
 * `promosOptInAppVersion` (auditoría interna, sin valor para el cliente) ni
 * `id`/`accountId` (el cliente ya sabe quién es por el token de sesión).
 */
export interface PortalPushPreferenceDto {
  serviceAlerts: boolean;
  promos: boolean;
}

export function toPortalPushPreferenceDto(pref: PortalPushPreference): PortalPushPreferenceDto {
  return { serviceAlerts: pref.serviceAlerts, promos: pref.promos };
}
