import type { PushSender, PushNotificationPayload, PushSendResult } from '@domain/ports/PushSender';

/**
 * NoopPushSender — degradado cuando `FIREBASE_SERVICE_ACCOUNT_JSON` NO está
 * configurada (portal-push-notifications). El sistema entero (registro de
 * tokens, preferencias, `POST /push-service-alert`) tiene que funcionar SIN
 * Firebase configurado — la credencial la carga el usuario después
 * (proyecto Firebase recién creado, `google-services.json` pendiente del
 * lado app). Nunca lanza, nunca marca tokens inválidos (no hay respuesta real
 * del proveedor para clasificar).
 */
export class NoopPushSender implements PushSender {
  readonly dryRun = true;

  async send(tokens: string[], notification: PushNotificationPayload): Promise<PushSendResult> {
    console.log(
      `[push] Firebase no configurado (FIREBASE_SERVICE_ACCOUNT_JSON ausente) — dry-run: "${notification.title}" NO se mandó a ${tokens.length} token(s)`,
    );
    return { invalidTokens: [] };
  }
}
