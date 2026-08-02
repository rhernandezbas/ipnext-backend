/**
 * PushSender — domain port (portal-push-notifications).
 *
 * Lives in the domain layer. Zero imports from @infrastructure/* — el adapter
 * real (`FcmPushSender`, FCM HTTP v1) y el degradado (`NoopPushSender`, sin
 * Firebase configurado) viven en infrastructure/adapters/fcm.
 */
export interface PushNotificationPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface PushSendResult {
  /**
   * Tokens que el proveedor reportó como muertos (FCM `UNREGISTERED`/
   * `INVALID_ARGUMENT`). El caller los marca `invalidAt` — nunca los borra.
   */
  invalidTokens: string[];
}

export interface PushSender {
  /**
   * `true` cuando este sender NO manda de verdad (p.ej. `NoopPushSender`
   * porque `FIREBASE_SERVICE_ACCOUNT_JSON` no está configurada). Expuesto en
   * el port (en vez de que el caller haga `instanceof NoopPushSender`, lo que
   * rompería DIP) para que `SendPushServiceAlert` pueda devolver `dryRun` sin
   * conocer la implementación concreta. Ausente/`undefined` == `false`.
   */
  readonly dryRun?: boolean;
  send(tokens: string[], notification: PushNotificationPayload): Promise<PushSendResult>;
}
