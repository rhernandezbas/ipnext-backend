import axios, { AxiosInstance } from 'axios';
import jwt from 'jsonwebtoken';
import type { PushSender, PushNotificationPayload, PushSendResult } from '@domain/ports/PushSender';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const FCM_SCOPE_ASSERTION_TTL = '1h';
/** Margen de seguridad antes de dar por vencido el access_token cacheado. */
const EXPIRY_SAFETY_MARGIN_MS = 60_000;
/** Códigos FCM v1 que significan "este token está muerto, no reintentar" (proposal). */
const DEAD_TOKEN_CODES = new Set(['UNREGISTERED', 'INVALID_ARGUMENT']);

interface FirebaseServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

export interface FcmPushSenderOptions {
  /** El JSON completo del service account de Firebase (FIREBASE_SERVICE_ACCOUNT_JSON), como string. */
  serviceAccountJson: string;
  /** Inyectable para tests. */
  http?: AxiosInstance;
  /** Default 15_000. */
  timeoutMs?: number;
  /** Clock seam para tests de expiración del token cacheado. */
  now?: () => number;
}

interface CachedToken {
  accessToken: string;
  /** epoch ms */
  expiresAt: number;
}

interface FcmErrorDetail {
  ['@type']?: string;
  errorCode?: string;
}

interface FcmErrorResponse {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: FcmErrorDetail[];
  };
}

/**
 * FcmPushSender — adapter REAL de `PushSender` contra FCM HTTP v1 (portal-push-notifications).
 *
 * Autenticación: OAuth2 "Server-to-Server" de Google — un JWT firmado RS256
 * con la `private_key` del service account (armado con `jsonwebtoken`, YA
 * dependencia del repo — sin sumar `firebase-admin`) se canjea por un
 * `access_token` en `TOKEN_URL`, cacheado hasta ~1min antes de vencer.
 *
 * `send`: FCM HTTP v1 NO tiene multicast — un POST por token
 * (`messages:send`), en paralelo. Tokens que el proveedor reporta
 * `UNREGISTERED`/`INVALID_ARGUMENT` (`details[].errorCode`, con fallback a
 * `error.status`) vuelven en `invalidTokens` — el caller los marca
 * `invalidAt`, NUNCA los borra acá.
 */
export class FcmPushSender implements PushSender {
  readonly dryRun = false;
  private readonly serviceAccount: FirebaseServiceAccount;
  private readonly http: AxiosInstance;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private cachedToken: CachedToken | null = null;

  constructor(opts: FcmPushSenderOptions) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(opts.serviceAccountJson);
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON no es JSON válido');
    }
    const sa = parsed as Partial<FirebaseServiceAccount>;
    if (!sa.project_id || !sa.client_email || !sa.private_key) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON incompleto (faltan project_id/client_email/private_key)');
    }
    this.serviceAccount = { project_id: sa.project_id, client_email: sa.client_email, private_key: sa.private_key };
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.now = opts.now ?? (() => Date.now());
    this.http = opts.http ?? axios.create({ timeout: this.timeoutMs });
  }

  private async getAccessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt - EXPIRY_SAFETY_MARGIN_MS > this.now()) {
      return this.cachedToken.accessToken;
    }

    const assertion = jwt.sign({ scope: SCOPE, aud: TOKEN_URL }, this.serviceAccount.private_key, {
      algorithm: 'RS256',
      issuer: this.serviceAccount.client_email,
      expiresIn: FCM_SCOPE_ASSERTION_TTL,
    });

    const body = new URLSearchParams();
    body.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    body.set('assertion', assertion);

    const response = await this.http.post(TOKEN_URL, body.toString(), {
      timeout: this.timeoutMs,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const data = response.data as { access_token: string; expires_in: number };
    this.cachedToken = { accessToken: data.access_token, expiresAt: this.now() + data.expires_in * 1000 };
    return this.cachedToken.accessToken;
  }

  async send(tokens: string[], notification: PushNotificationPayload): Promise<PushSendResult> {
    if (tokens.length === 0) return { invalidTokens: [] };

    const accessToken = await this.getAccessToken();
    const url = `https://fcm.googleapis.com/v1/projects/${this.serviceAccount.project_id}/messages:send`;

    const results = await Promise.allSettled(
      tokens.map((token) =>
        this.http.post(
          url,
          {
            message: {
              token,
              notification: { title: notification.title, body: notification.body },
              ...(notification.data ? { data: notification.data } : {}),
            },
          },
          { timeout: this.timeoutMs, headers: { Authorization: `Bearer ${accessToken}` } },
        ),
      ),
    );

    const invalidTokens: string[] = [];
    results.forEach((result, i) => {
      if (result.status === 'rejected' && isDeadTokenError(result.reason)) {
        invalidTokens.push(tokens[i] as string);
      }
    });
    return { invalidTokens };
  }
}

/** `true` cuando el error de un envío individual es UNREGISTERED/INVALID_ARGUMENT (token muerto). */
function isDeadTokenError(err: unknown): boolean {
  const e = err as { isAxiosError?: boolean; response?: { data?: FcmErrorResponse } } | null;
  if (!e?.isAxiosError) return false;
  const error = e.response?.data?.error;
  if (!error) return false;
  const detailCode = error.details?.find((d) => typeof d.errorCode === 'string')?.errorCode;
  return DEAD_TOKEN_CODES.has(detailCode ?? '') || DEAD_TOKEN_CODES.has(error.status ?? '');
}
