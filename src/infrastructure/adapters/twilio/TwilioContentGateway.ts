import axios, { AxiosInstance } from 'axios';
import type { TemplateDto, TemplateMessagingPort, SendTemplateResult } from '@domain/ports/TemplateMessagingPort';
import {
  TemplateProviderUnavailableError,
  TemplateSendRejectedError,
  TemplateProviderConfigError,
} from '@domain/errors/messaging-bulk';

export interface TwilioContentGatewayOptions {
  /** TWILIO_ACCOUNT_SID (AC…). */
  accountSid: string;
  /** TWILIO_AUTH_TOKEN. */
  authToken: string;
  /** TWILIO_MESSAGING_SERVICE_SID (MG…) — el MISMO Messaging Service que el inbox F1 (design §6). */
  messagingServiceSid: string;
  /** Default 'https://content.twilio.com' (Content API — listTemplates). */
  contentBaseUrl?: string;
  /** Default 'https://api.twilio.com' (Messages API — sendTemplate). */
  apiBaseUrl?: string;
  /** Inyectable para tests — SIN baseURL propio: Content y Messages viven en HOSTS DISTINTOS. */
  http?: AxiosInstance;
  /** Default 15_000. */
  timeoutMs?: number;
}

const DEFAULT_CONTENT_BASE_URL = 'https://content.twilio.com';
const DEFAULT_API_BASE_URL = 'https://api.twilio.com';
const DEFAULT_TIMEOUT_MS = 15_000;

/** Estados HTTP retryables — clon EXACTO del criterio de `GestionRealClient` (design §2.2/§5.2). */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * messaging-bulk fix wave (FIX-2) — estados SISTÉMICOS de auth/config del
 * proveedor: 401 (token mal/rotado), 403 (sin permiso), 404 (recurso inexistente
 * — típicamente `accountSid` vacío → URL `/Accounts//Messages.json`). No son
 * fallas per-mensaje: afectan a TODOS los envíos. Se mapean a
 * `TemplateProviderConfigError` (aborta el run) en vez de `TemplateSendRejectedError`
 * (que quemaría cada recipient a `failed` terminal).
 */
const CONFIG_STATUS = new Set([401, 403, 404]);

/**
 * TwilioContentGateway (F2, T5.1, design §2.2) — adapter REAL de
 * `TemplateMessagingPort` contra la API de Twilio. Patrón axios idéntico a
 * `HttpChatwootGateway`/`GestionRealClient` (ctor con `http` inyectable para
 * tests — NUNCA axios/nock real en tests, regla TDD del repo).
 *
 * DOS hosts distintos y DOS content-types distintos:
 *  - `listTemplates()` → GET `content.twilio.com` (Content API, JSON).
 *  - `sendTemplate()`  → POST `api.twilio.com` (Messages API, **form-urlencoded**,
 *    a diferencia de la Content API — gotcha explícito del batch).
 *
 * Basic auth en ambos (`accountSid:authToken`).
 */
export class TwilioContentGateway implements TemplateMessagingPort {
  private readonly http: AxiosInstance;
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly messagingServiceSid: string;
  private readonly contentBaseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: TwilioContentGatewayOptions) {
    this.accountSid = opts.accountSid;
    this.authToken = opts.authToken;
    this.messagingServiceSid = opts.messagingServiceSid;
    this.contentBaseUrl = opts.contentBaseUrl ?? DEFAULT_CONTENT_BASE_URL;
    this.apiBaseUrl = opts.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Sin baseURL: content.twilio.com y api.twilio.com son hosts distintos —
    // cada método arma la URL completa.
    this.http = opts.http ?? axios.create({ timeout: this.timeoutMs });
  }

  private auth() {
    return { username: this.accountSid, password: this.authToken };
  }

  /**
   * design §2.2 — GET `/v1/ContentAndApprovals?PageSize=200`, pagina con
   * `meta.next_page_url` hasta `null`. CUALQUIER falla acá (red/timeout/4xx/5xx)
   * es "el proveedor no disponible" (TPL-1) — no hay semántica per-mensaje en
   * un listado.
   */
  async listTemplates(): Promise<TemplateDto[]> {
    const templates: TemplateDto[] = [];
    let url: string | null = `${this.contentBaseUrl}/v1/ContentAndApprovals?PageSize=200`;

    while (url) {
      let data: TwilioContentAndApprovalsResponse;
      try {
        const response = await this.http.get(url, { auth: this.auth(), timeout: this.timeoutMs });
        data = response.data as TwilioContentAndApprovalsResponse;
      } catch (err) {
        throw new TemplateProviderUnavailableError(errorMessage(err));
      }

      for (const item of data.contents ?? []) {
        templates.push(toTemplateDto(item));
      }

      const next = data.meta?.next_page_url ?? null;
      url = next ? (next.startsWith('http') ? next : `${this.contentBaseUrl}${next}`) : null;
    }

    return templates;
  }

  /**
   * design §2.2 — POST `/2010-04-01/Accounts/{AccountSid}/Messages.json`.
   * **OJO**: la Messages API es `application/x-www-form-urlencoded`, NO JSON
   * (a diferencia de la Content API arriba). `to` YA viene E164 con '+'
   * (`toWhatsAppE164`); acá se antepone el prefijo `whatsapp:`.
   */
  async sendTemplate(to: string, contentSid: string, variables: Record<string, string>): Promise<SendTemplateResult> {
    // FIX-2 — guard proactivo: sin credenciales completas la URL sería
    // `/Accounts//Messages.json` (accountSid vacío) o el auth fallaría — una
    // falla SISTÉMICA, no per-mensaje. Fallar acá con un error de config claro
    // (aborta el run) evita quemar miles de recipients a `failed` terminal.
    if (!this.accountSid || !this.authToken || !this.messagingServiceSid) {
      throw new TemplateProviderConfigError(
        'Twilio no está configurado (faltan accountSid/authToken/messagingServiceSid)',
      );
    }

    const body = new URLSearchParams();
    body.set('MessagingServiceSid', this.messagingServiceSid);
    body.set('To', `whatsapp:${to}`);
    body.set('ContentSid', contentSid);
    body.set('ContentVariables', JSON.stringify(variables));

    try {
      const response = await this.http.post(
        `${this.apiBaseUrl}/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
        body.toString(),
        {
          auth: this.auth(),
          timeout: this.timeoutMs,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        },
      );
      const data = response.data as { sid: string; status: string };
      return { providerId: data.sid, status: data.status };
    } catch (err) {
      throw this.mapSendError(err);
    }
  }

  /**
   * design §2.2/§5.2 + fix wave (FIX-2) — mapeo de errores de `sendTemplate`:
   *  - sin `response` (red/timeout) o status ∈ RETRYABLE_STATUS →
   *    `TemplateProviderUnavailableError` (retryable; 429 expone `retryAfterMs`).
   *  - status ∈ CONFIG_STATUS (401/403/404) → `TemplateProviderConfigError`
   *    (SISTÉMICO: token/config mal — aborta el run, NO quema per-recipient).
   *  - cualquier otro 4xx (400/422 → número inválido, content_sid malo…) →
   *    `TemplateSendRejectedError` (terminal para ESE destinatario, no aborta
   *    el lote — SendCampaign decide eso).
   */
  private mapSendError(err: unknown): Error {
    const e = err as AxiosLikeError | null;
    if (!e || e.isAxiosError !== true) {
      return new TemplateProviderUnavailableError(errorMessage(err));
    }
    const status = e.response?.status;
    if (status === undefined) {
      return new TemplateProviderUnavailableError(errorMessage(err)); // red/timeout
    }
    if (RETRYABLE_STATUS.has(status)) {
      const retryAfter = status === 429 ? retryAfterMs(e) : undefined;
      return new TemplateProviderUnavailableError(errorMessage(err), retryAfter);
    }
    if (CONFIG_STATUS.has(status)) {
      return new TemplateProviderConfigError(errorMessage(err));
    }
    return new TemplateSendRejectedError(errorMessage(err));
  }
}

interface AxiosLikeError {
  isAxiosError?: boolean;
  message?: string;
  response?: { status?: number; headers?: Record<string, unknown>; data?: unknown };
}

/**
 * HIST-3 + fix wave (FIX-7a) — mensaje SANEADO: nunca el objeto/response crudo
 * del proveedor (headers, body completo, credenciales) — solo un string legible
 * con el status Y el `code` numérico de Twilio (ej. 21211 número inválido, 63016
 * fuera de ventana, 21610 opt-out) cuando viene, para poder DIAGNOSTICAR el
 * fallo por-fila desde `CampaignRecipient.error`. El `code` de Twilio es un
 * entero de catálogo, NO es PII.
 */
function errorMessage(err: unknown): string {
  const e = err as AxiosLikeError | null;
  if (e?.isAxiosError) {
    const status = e.response?.status;
    if (status !== undefined) {
      const twilioCode = twilioErrorCode(e);
      return twilioCode !== undefined
        ? `Twilio respondió con status ${status} (code ${twilioCode})`
        : `Twilio respondió con status ${status}`;
    }
    return `Twilio request falló: ${e.message ?? 'network error'}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Extrae el `code` numérico del body de error de Twilio (`{code, message, …}`).
 * Solo el entero — NUNCA el `message` (podría traer el número destino) ni el
 * resto del body (HIST-3).
 */
function twilioErrorCode(e: AxiosLikeError): number | undefined {
  const data = e.response?.data as { code?: unknown } | undefined;
  const code = data?.code;
  return typeof code === 'number' ? code : undefined;
}

/** Retry-After (ms) de un 429 — misma lógica que `GestionRealClient.retryAfterMs`. */
function retryAfterMs(e: AxiosLikeError): number | undefined {
  const headers = e.response?.headers ?? {};
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  if (raw === undefined || raw === null) return undefined;
  const secs = parseInt(String(raw), 10);
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : undefined;
}

interface TwilioContentItem {
  sid: string;
  friendly_name: string;
  language: string;
  variables?: Record<string, string>;
  approval_requests?: { status?: string; category?: string };
}

interface TwilioContentAndApprovalsResponse {
  contents?: TwilioContentItem[];
  meta?: { next_page_url?: string | null };
}

function normalizeApprovalStatus(status: string | undefined): TemplateDto['approvalStatus'] {
  if (status === 'approved' || status === 'pending' || status === 'rejected' || status === 'unsubmitted') return status;
  return 'unsubmitted';
}

function toTemplateDto(item: TwilioContentItem): TemplateDto {
  return {
    contentSid: item.sid,
    friendlyName: item.friendly_name,
    language: item.language,
    variables: item.variables ?? {},
    approvalStatus: normalizeApprovalStatus(item.approval_requests?.status),
    category: item.approval_requests?.category,
  };
}
