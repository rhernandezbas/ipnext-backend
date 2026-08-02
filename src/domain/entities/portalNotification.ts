/**
 * PortalNotification — domain entity (portal-notification-inbox).
 *
 * El buzón del portal: cada aviso se persiste POR CUENTA al momento del envío
 * (ver `SendPushServiceAlert`), sea o no que el push haya llegado de verdad al
 * dispositivo — es el respaldo para el cliente que negó el permiso de
 * notificaciones o perdió el token. Motivador (feedback del usuario probando
 * el push real): "se mandó la notificación pero no persiste en ningún lado de
 * la app, por lo cual la persona puede abrirla sin leerla" — sin buzón, un
 * push no tocado en el momento se pierde para siempre.
 *
 * `channel` reusa el MISMO eje que `PortalPushPreference.serviceAlerts`/
 * `promos` — hoy solo `SendPushServiceAlert` escribe filas ('service'); el
 * envío de promos queda fuera de este change (mismo scope que
 * portal-push-notifications), pero el modelo ya contempla el canal.
 *
 * `data` es el MISMO payload `data` del push (ej. `{url}`) para permitir deep
 * link desde el buzón — `null`/ausente cuando el aviso no lleva uno.
 *
 * `readAt` null = no leída.
 */
export interface PortalNotification {
  id: string;
  accountId: string;
  channel: 'service' | 'promo';
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  sentAt: string;
  readAt: string | null;
}
