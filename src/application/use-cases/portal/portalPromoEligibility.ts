import type { PortalPromo } from '@domain/entities/portalPromo';

/**
 * portal-promos — condiciones de tiempo/publicación de una promo, SIN el
 * cliente (ni segmento, ni "ya respondió"): `publishedAt` no null,
 * `archivedAt` null, `now` dentro de `[startsAt, endsAt]`. Función pura
 * compartida por `GetPortalPromo` (re-chequeo del detalle),
 * `InterestInPortalPromo` y `DismissPortalPromo` (antes de crear una
 * respuesta nueva) — UNA sola implementación de "¿esta promo está viva
 * ahora?", igual que `buildSegmentWhere` es la única implementación del
 * armado del WHERE de segmento.
 */
export function isPortalPromoEligibleNow(promo: PortalPromo, now: Date): boolean {
  if (!promo.publishedAt || promo.archivedAt) return false;
  const nowMs = now.getTime();
  if (new Date(promo.startsAt).getTime() > nowMs) return false;
  if (new Date(promo.endsAt).getTime() < nowMs) return false;
  return true;
}
