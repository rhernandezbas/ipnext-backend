import type { CampaignRepository, CampaignPatch } from '@domain/ports/CampaignRepository';
import type { CampaignRecipientLookup, CampaignRecipientCandidate } from '@domain/ports/CustomerRepository';
import type { TemplateMessagingPort } from '@domain/ports/TemplateMessagingPort';
import type { RateLimiter } from '@domain/ports/RateLimiter';
import type { Campaign, CampaignRecipient, CampaignVariableSpec } from '@domain/entities/campaign';
import type { SendTemplateResult } from '@domain/ports/TemplateMessagingPort';
import { CampaignNotFoundError, TemplateProviderConfigError } from '@domain/errors/messaging-bulk';
import { sendWithRetry, CampaignRetryOptions } from './campaignBackoff';

export interface SendCampaignInput {
  campaignId: string;
}

/**
 * Tamaño de batch del drenaje keyset (FIX-4-v2) — molde
 * `InMemoryCampaignRepository.DEFAULT_PAGE_SIZE`. ACOTADO: la memoria del envío es
 * O(RESUME_PAGE_SIZE), NO O(total), sea cual sea el tamaño de la campaña (50-100k
 * recipients no cargan de golpe). Se mantiene chico (25) a propósito: el
 * rate-limit de Twilio domina la latencia, no el número de round-trips de paginado.
 */
export const RESUME_PAGE_SIZE = 25;

/** FIX-5 — intentos de persistir el `sent` de un envío YA aceptado por el proveedor. */
const PERSIST_SENT_MAX_ATTEMPTS = 3;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });

/**
 * messaging-bulk (F2, T4.3, design §3.4) — `SendCampaign`, el executor
 * (molde `RunBulkEnforcement.execute`). `CampaignRunner` (T4.4) es el shell
 * fire-and-forget con lock que lo invoca; este use case es el LOOP real,
 * invocable también directo en tests.
 *
 * - **Resumible (SEND-6)**: solo toca recipients `queued`/`failed` — los
 *   terminales (`sent`/`opted_out`/`skipped`) de una corrida previa quedan
 *   intactos.
 * - **Rate-limit proactivo (SEND-4)**: `rateLimiter.acquire()` UNA vez por
 *   recipient, ANTES del `sendTemplate` — nunca dentro del retry interno.
 * - **Backoff 429-aware (SEND-3)**: delega en `sendWithRetry` (T4.2).
 * - **Re-check opt-out (SEND-5)**: `customerRepo.findRecipientCandidate`
 *   INMEDIATAMENTE antes de cada envío — nunca cacheado entre recipients.
 * - **Contadores REALES (SEND-7)**: al cierre, recomputa cada contador desde
 *   `campaignRepo.listRecipients(...).total` (nunca `.data.length` truncado
 *   por página) — correcto sea cual sea el estado de una corrida previa.
 */
export class SendCampaign {
  constructor(
    private readonly campaignRepo: CampaignRepository,
    private readonly customerRepo: CampaignRecipientLookup,
    private readonly templatePort: TemplateMessagingPort,
    private readonly rateLimiter: RateLimiter,
    private readonly backoffOpts?: CampaignRetryOptions,
  ) {}

  async execute(input: SendCampaignInput): Promise<Campaign> {
    const campaign = await this.campaignRepo.findById(input.campaignId);
    if (!campaign) throw new CampaignNotFoundError(input.campaignId);

    await this.drainQueue(campaign);

    return this.finalize(campaign.id);
  }

  /**
   * Recorre TODOS los recipients `queued`/`failed` — SERIAL, un carril (Twilio
   * limita GLOBAL, no per-destino).
   *
   * ── fix wave (FIX-4): drop silencioso por paginación inestable ─────────────
   * La versión original paginaba con `skip/take` (page fija + `page++`). Como
   * `bulkCreateRecipients` (createMany) escribe `createdAt` IDÉNTICO a todas las
   * filas, el orden bajo empates NO es determinístico en Postgres; combinado con
   * un set que MUTA (recipients saliendo del filtro al pasar a terminal) podía
   * SALTEAR un recipient → nunca procesado, pero `finalize` marcaba `done` igual
   * (viola SEND-7). FIX-4 fijó el orden total `[createdAt, id]` en el adapter.
   *
   * ── fix wave 3 (FIX-4-v2): memoria ACOTADA por paginación keyset ───────────
   * FIX-4 (v1) drenaba trayendo el conjunto COMPLETO de pendientes en UNA query
   * (`limit = total`) y reteniéndolo en memoria toda la corrida → OOM en campañas
   * de 50-100k. Ahora se pagina con KEYSET sobre ese mismo orden total: un batch
   * ACOTADO (`RESUME_PAGE_SIZE`) por vuelta, avanzando el cursor `after` al último
   * recipient procesado. La memoria es O(RESUME_PAGE_SIZE), no O(total). El
   * cursor keyset es ESTABLE ante la mutación del set (nunca revisita antes del
   * cursor), así que cada recipient se procesa exactamente UNA vez sin reintroducir
   * el skip del `skip/take` — sin necesidad del viejo `processedIds`. Un `failed`
   * queda detrás del cursor (no se reintenta en ESTA corrida; sigue resumible en
   * una FUTURA, donde arranca de cero), mismo comportamiento que antes.
   */
  private async drainQueue(campaign: Campaign): Promise<void> {
    let cursor: { createdAt: string; id: string } | undefined;

    for (;;) {
      const batch = await this.campaignRepo.listRecipientsKeyset(campaign.id, {
        statusIn: ['queued', 'failed'],
        limit: RESUME_PAGE_SIZE,
        after: cursor,
      });
      if (batch.length === 0) break;

      for (const recipient of batch) {
        await this.processRecipient(campaign, recipient);
      }

      const last = batch[batch.length - 1];
      cursor = { createdAt: last.createdAt, id: last.id };
    }
  }

  private async processRecipient(campaign: Campaign, recipient: CampaignRecipient): Promise<void> {
    // SEND-5 — re-check de opt-out INMEDIATAMENTE ANTES de enviar (puede haber
    // cambiado entre CreateCampaign y el turno de este recipient en el worker).
    const candidate = await this.customerRepo.findRecipientCandidate(recipient.clientId);
    if (!candidate) {
      await this.campaignRepo.updateRecipient(recipient.id, {
        status: 'skipped',
        error: 'Client no longer resolvable at send time',
      });
      return;
    }
    if (candidate.whatsappOptOutAt != null) {
      await this.campaignRepo.updateRecipient(recipient.id, { status: 'opted_out' });
      return;
    }

    const variables = resolveCampaignVariables(campaign.variableSpec, candidate);

    let result: SendTemplateResult;
    try {
      await this.rateLimiter.acquire(); // SEND-4 — proactivo, UNA vez por recipient, ANTES del send
      result = await sendWithRetry(
        () => this.templatePort.sendTemplate(recipient.phoneE164, campaign.templateRef, variables),
        this.backoffOpts,
      );
    } catch (err) {
      // FIX-2 — una falla SISTÉMICA de auth/config (token rotado, accountSid
      // vacío) NO es per-destinatario: PROPAGAR para ABORTAR el run (campaña
      // `failed` con motivo claro, recipients siguen `queued`), en vez de quemar
      // a este (y a los miles siguientes) a `failed` terminal.
      if (err instanceof TemplateProviderConfigError) throw err;
      // best-effort (SEND-2): un fallo por-destinatario NUNCA aborta el resto del batch.
      await this.persistRecipientFailed(recipient.id, err);
      return;
    }

    // FIX-5 — el envío YA fue aceptado por el proveedor. Un hipo de DB al
    // persistir el `sent` NO debe convertirlo en `failed` (sería resumible →
    // RE-ENVÍO al mismo destinatario). Se reintenta el persist; si aun así
    // falla, se LOGUEA y se deja como está (nunca se marca `failed`).
    await this.persistRecipientSent(recipient.id, result);
  }

  /** FIX-5 — persiste `sent` con reintentos; jamás marca `failed` un envío aceptado. */
  private async persistRecipientSent(recipientId: string, result: SendTemplateResult): Promise<void> {
    const sleep = this.backoffOpts?.sleep ?? defaultSleep;
    const sentAt = new Date().toISOString();
    for (let attempt = 1; ; attempt++) {
      try {
        await this.campaignRepo.updateRecipient(recipientId, {
          status: 'sent',
          providerId: result.providerId,
          sentAt,
        });
        return;
      } catch (err) {
        if (attempt >= PERSIST_SENT_MAX_ATTEMPTS) {
          // eslint-disable-next-line no-console
          console.error(
            `[SendCampaign] envío aceptado (providerId=${result.providerId}) pero no se pudo persistir 'sent' para recipient ${recipientId} tras ${attempt} intentos:`,
            err instanceof Error ? err.message : err,
          );
          return; // NO marcar failed — un envío aceptado nunca vuelve a ser re-enviable acá.
        }
        await sleep(50 * attempt);
      }
    }
  }

  /** best-effort: marca `failed` un fallo per-destinatario; si el propio write falla, loguea. */
  private async persistRecipientFailed(recipientId: string, err: unknown): Promise<void> {
    try {
      await this.campaignRepo.updateRecipient(recipientId, {
        status: 'failed',
        // HIST-3 — ya viene saneado: los errores tipados del port (Batch 5)
        // nunca cargan el payload/response crudo del proveedor en `.message`.
        error: err instanceof Error ? err.message : String(err),
      });
    } catch (persistErr) {
      // eslint-disable-next-line no-console
      console.error(
        `[SendCampaign] no se pudo persistir 'failed' para recipient ${recipientId}:`,
        persistErr instanceof Error ? persistErr.message : persistErr,
      );
    }
  }

  /**
   * SEND-7 — cierre con contadores REALES: consulta el `.total` del repo
   * (nunca truncado por página) para cada status terminal, en vez de derivar
   * de estado local acumulado en ESTA corrida (que no reflejaría recipients
   * ya terminales de una corrida previa interrumpida, SEND-6).
   */
  private async finalize(campaignId: string): Promise<Campaign> {
    const [sent, failed, skipped, optedOut] = await Promise.all([
      this.campaignRepo.listRecipients(campaignId, { statusIn: ['sent'], limit: 1 }),
      this.campaignRepo.listRecipients(campaignId, { statusIn: ['failed'], limit: 1 }),
      this.campaignRepo.listRecipients(campaignId, { statusIn: ['skipped'], limit: 1 }),
      this.campaignRepo.listRecipients(campaignId, { statusIn: ['opted_out'], limit: 1 }),
    ]);

    const patch: CampaignPatch = {
      status: 'done',
      sentCount: sent.total,
      failedCount: failed.total,
      skippedCount: skipped.total,
      optedOutCount: optedOut.total,
      finishedAt: new Date().toISOString(),
    };
    return this.campaignRepo.update(campaignId, patch);
  }
}

/**
 * FIX-18 — formatea un monto como ARS legible: `$` + parte entera con separador
 * de miles `.` y, solo si hay centavos, `,dd` (convención es-AR). Determinística
 * (sin `Intl`, para no depender del ICU del runtime): `50000` → `$50.000`,
 * `12345.5` → `$12.345,50`, `999` → `$999`, `0` → `$0`.
 */
export function formatArs(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  const negative = rounded < 0;
  const [intPart, decPart] = Math.abs(rounded).toFixed(2).split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const body = decPart === '00' ? grouped : `${grouped},${decPart}`;
  return `${negative ? '-' : ''}$${body}`;
}

/**
 * Resuelve cada variable del template contra el `Client` fresco (candidate) —
 * design §3.3: personalización POR-DESTINATARIO ("monto_deuda" varía por
 * cliente, el sentido de un recordatorio de deuda).
 *
 * ── fix wave 2 (FIX-18): `balanceDue` legible y NULL con gracia ─────────────
 * Antes: `String(candidate.balanceDue ?? 0)` → un recordatorio decía "$0" (un
 * never-synced con `balanceDue = null`) o el número crudo ("50000"). Ahora un
 * monto conocido se formatea ARS legible (`formatArs`), y un `balanceDue = null`
 * (never-synced, monto NO confirmable) resuelve a string VACÍO — NUNCA "$0", que
 * implicaría falsamente deuda cero. Decisión de producto: el template debe
 * redactarse tolerando el monto vacío, o el segmento acotarse con `balanceMin > 0`
 * (FIX-12) para garantizar monto conocido en toda la audiencia.
 */
export function resolveCampaignVariables(
  variableSpec: CampaignVariableSpec,
  candidate: CampaignRecipientCandidate,
): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [key, entry] of Object.entries(variableSpec)) {
    switch (entry.source) {
      case 'name':
        variables[key] = candidate.name;
        break;
      case 'balanceDue':
        variables[key] = candidate.balanceDue == null ? '' : formatArs(candidate.balanceDue);
        break;
      case 'literal':
        variables[key] = entry.value ?? '';
        break;
    }
  }
  return variables;
}
