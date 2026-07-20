/**
 * bulk-granular-perms — servicio de dominio PURO (sin infra) que decide si un
 * usuario puede disparar un envío masivo a un conjunto de destinatarios, según
 * los permisos granulares por ESTADO de cliente + para NÚMEROS crudos.
 *
 * Regla del feature (decisión del usuario): se BLOQUEA la campaña completa si
 * el usuario no tiene permiso para ALGÚN estado/tipo presente en los
 * destinatarios (NO se filtra), sobre TODOS los destinatarios (segmento + nodo/
 * AP + manuales + números), sin bypass — salvo super_admin.
 *
 * Vive en el dominio: cero dependencias de Prisma/Express/Node. Los use cases
 * (`CreateCampaign`, `AuthorizeCampaignSend`) y las rutas lo consumen.
 */

/**
 * Sentinel de super_admin. Si el set de acciones permitidas lo contiene, NUNCA
 * se prohíbe nada (el super_admin bypassa el gate, igual que en requirePermission).
 */
export const BULK_SUPER_ADMIN_SENTINEL = '*';

/**
 * Mapeo estado de cliente (enum `ClientStatus`) → acción RBAC que habilita el
 * envío masivo a ese estado. Un estado que NO esté acá se trata como NO
 * permitido (bloqueo defensivo — nunca se envía a un estado desconocido/nuevo
 * sin un permiso explícito para él).
 */
export const BULK_STATUS_ACTION: Readonly<Record<string, string>> = {
  active: 'bulk_active',
  late: 'bulk_late',
  blocked: 'bulk_blocked',
  inactive: 'bulk_inactive',
  baja: 'bulk_baja',
};

/** Acción RBAC que habilita el envío a NÚMEROS crudos (destinatario sin `Client`). */
export const BULK_NUMBERS_ACTION = 'bulk_numbers';

/** Etiqueta legible de "números crudos" en la lista de prohibidos. */
export const RAW_NUMBER_LABEL = 'números';

/** Forma mínima de un destinatario para el chequeo de autorización. */
export interface BulkTargetLike {
  /** `null` = número crudo (sin `Client` vinculado) → requiere `bulk_numbers`. */
  clientId: string | null;
  /** Estado del cliente (`active`/`late`/…) cuando `clientId` no es null. */
  status: string;
}

/**
 * Devuelve las ETIQUETAS de lo PROHIBIDO para este usuario dentro del conjunto
 * de destinatarios: el estado de cliente (`'blocked'`, `'baja'`, …) o `'números'`
 * para los crudos. Distinct + ordenado (determinístico).
 *
 * - `allowedActions` incluye `'*'` (super_admin) → SIEMPRE `[]` (nunca prohíbe).
 * - Destinatario con `clientId === null` → requiere `bulk_numbers`; si falta,
 *   se agrega `'números'`.
 * - Destinatario con `clientId` → requiere `bulk_<status>`; si el estado es
 *   desconocido (no está en `BULK_STATUS_ACTION`) o falta el permiso, se agrega
 *   la etiqueta del estado (bloqueo defensivo).
 *
 * Puro: no muta `recipients`, nunca throws.
 */
export function forbiddenBulkTargets(
  allowedActions: Set<string>,
  recipients: BulkTargetLike[],
): string[] {
  if (allowedActions.has(BULK_SUPER_ADMIN_SENTINEL)) return [];

  const forbidden = new Set<string>();
  for (const recipient of recipients) {
    if (recipient.clientId === null) {
      if (!allowedActions.has(BULK_NUMBERS_ACTION)) forbidden.add(RAW_NUMBER_LABEL);
      continue;
    }
    const requiredAction = BULK_STATUS_ACTION[recipient.status];
    if (requiredAction === undefined || !allowedActions.has(requiredAction)) {
      // status desconocido O sin el permiso del estado → bloqueo defensivo.
      forbidden.add(recipient.status);
    }
  }

  return [...forbidden].sort((a, b) => a.localeCompare(b));
}
