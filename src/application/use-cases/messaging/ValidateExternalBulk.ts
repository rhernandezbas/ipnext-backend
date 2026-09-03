import type { ExternalBulkPreviewRepository } from '@domain/ports/ExternalBulkPreviewRepository';
import type { ExternalBulkMessagingConfigRepository } from '@domain/ports/ExternalBulkMessagingConfigRepository';
import type { CampaignRepository } from '@domain/ports/CampaignRepository';
import type { TemplateMessagingPort, TemplateDto } from '@domain/ports/TemplateMessagingPort';
import type { CampaignSegmentSource } from '@domain/ports/CustomerRepository';
import type { ChatwootGateway } from '@domain/ports/ChatwootGateway';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { CreditBalancePort } from '@domain/ports/CreditBalancePort';
import type { MessagingRatesConfig, MessagingRatesConfigRepository } from '@domain/ports/MessagingRatesConfigRepository';
import { MESSAGING_RATES_CONFIG_DEFAULTS } from '@domain/ports/MessagingRatesConfigRepository';
import type {
  ValidateExternalBulkInput,
  ValidateExternalBulkOutput,
  ValidateExternalBulkValidRecipientDto,
  ValidateExternalBulkInvalidRecipientDto,
  ExternalBulkInvalidReason,
  ExternalBulkWarning,
} from '@application/dto/external-bulk-messaging.dto';
import {
  FeatureExternalBulkDisabledError,
  ExternalBulkValidationError,
  CapExceededError,
  EmptyRecipientsError,
  ChatwootLabelNotFoundError,
  ReporterUnavailableError,
} from '@domain/errors/external-bulk-messaging';
import { estimateMessagingCost, MessagingCreditDto } from './EstimateMessagingCost';
import { TemplateNotApprovedError } from '@domain/errors/messaging-bulk';
import { ChatwootUnavailableError } from '@domain/errors/messaging';
import { matchManualContacts, ManualContactInput, ManualContactResolution } from './matchManualContacts';
import { toWhatsAppE164 } from './toWhatsAppE164';
import { normalizePhone } from '@application/use-cases/recapture/matchActiveClient';
import { renderTemplateBody } from './SendCampaign';
import { externalBulkPayloadHash } from './externalBulkPayloadHash';
import { toArgentinaDateKey } from './reportsTimezone';
import { API_MESSAGING_USER_LOGIN } from '@domain/constants/machineUsers';
import { MAX_MANUAL_CONTACTS } from './resolveCombinedRecipients';

const FEATURE_FLAG_KEY = 'messaging-external-bulk-enabled';
/** fix wave F1 (F7) — perilla PROPIA del guard de credito. Ver SendExternalBulk. */
const CREDIT_GUARD_FLAG_KEY = 'messaging-credit-guard-enabled';
const PREVIEW_TTL_MS = 15 * 60 * 1000;
const PURGE_HORIZON_MS = 24 * 60 * 60 * 1000;
const PURGE_LIMIT = 500;

/**
 * external-bulk-messaging (Batch 2, VAL-1..VAL-10, KS-1) — primer paso del
 * flujo M2M de 2 pasos: normaliza/valida un lote, renderiza el mensaje POR
 * RECIPIENT y persiste un `ExternalBulkPreview` efímero (15 min) — NUNCA
 * envía nada. `SendExternalBulk` (Batch 3) consume el preview.
 *
 * Orden (design.md D0, reconciliado con tasks.md 2.5 — el design lista "cap
 * por request" antes de "template"/"matchManualContacts", pero eso es SOLO la
 * lectura temprana de la config; la comparación de los DOS caps corre recién
 * DESPUÉS del merge de variables, sobre el `valid.length` YA descontado de
 * `variables_faltantes`, tal cual dice 2.5 explícitamente):
 *   1. flag (KS-1, fail-safe OFF)
 *   2. forma del input (VAL-1)
 *   3. config (lectura temprana, sin comparar aún)
 *   4. template aprobado (VAL-4/D4.d)
 *   5. matchManualContacts — formato/opt-out/link (VAL-2)
 *   6. label de Chatwoot si vino (VAL-5)
 *   7. merge de variables POR RECIPIENT + render (VAL-10/VAL-3)
 *   8. EMPTY_RECIPIENTS si no quedó ningún valid (VAL-3 scenario 2)
 *   9. cap por request, luego cap diario (VAL-6/VAL-7)
 *  10. persist preview (VAL-8) + purga best-effort (D9)
 */
export class ValidateExternalBulk {
  constructor(
    private readonly previewRepo: ExternalBulkPreviewRepository,
    private readonly configRepo: ExternalBulkMessagingConfigRepository,
    private readonly campaignRepo: CampaignRepository,
    private readonly templatePort: TemplateMessagingPort,
    private readonly segmentSource: CampaignSegmentSource,
    private readonly chatwootGateway: ChatwootGateway,
    private readonly featureFlags: FeatureFlagRepository,
    private readonly rbacUserRepo: RbacUserRepository,
    private readonly creditPort: CreditBalancePort,
    private readonly ratesRepo: MessagingRatesConfigRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: ValidateExternalBulkInput): Promise<ValidateExternalBulkOutput> {
    // 1 — KS-1, fail-safe a OFF (molde SendTemplateMessage.resolveViaChat).
    if (!(await this.resolveFlagEnabled())) {
      throw new FeatureExternalBulkDisabledError();
    }

    // 2 — VAL-1, forma del input. CERO llamadas downstream si falla.
    assertValidShape(input);
    const globalVariables = input.variables ?? {};
    const chatwootLabel = input.chatwootLabel ?? null;

    // 3 — lectura temprana de config (defaults 500/2000 si no hay fila, CONFIG-1).
    // fix wave F1 (F4) — clamp DEFENSIVO al techo del motor de envío.
    // `SetExternalBulkConfig` ya rechaza un `maxPerRequest` mayor, pero la fila
    // es editable por fuera del use case (SQL a mano, un seed viejo): si igual
    // llega un tope > MAX_MANUAL_CONTACTS, `validate` prometería un lote que el
    // `send` no puede despachar (`TooManyManualContactsError`, 422 eterno sobre
    // un preview ya persistido). Se corrige acá, no se confía en el escritor.
    const persistedConfig = await this.configRepo.get();
    const config = {
      ...persistedConfig,
      maxPerRequest: Math.min(persistedConfig.maxPerRequest, MAX_MANUAL_CONTACTS),
    };

    // 4 — VAL-4/D4.d — template debe existir y estar approved.
    const templates = await this.templatePort.listTemplates();
    const template = resolveTemplate(templates, input.templateRef, input.templateName);
    if (!template || template.approvalStatus !== 'approved') {
      throw new TemplateNotApprovedError(input.templateRef ?? input.templateName ?? '');
    }

    // 5 — VAL-2 — formato (E.164 AR via toWhatsAppE164, extranjero explicito = invalido) / opt-out / link + dedup intra-batch.
    const { candidates, invalid: invalidFromMatch } = await this.classifyRecipients(input.recipients);

    // 6 — VAL-5 — label de Chatwoot (si vino) contra el catálogo VIVO.
    if (chatwootLabel) {
      await this.assertLabelExists(chatwootLabel);
    }

    // 7 — VAL-10/VAL-3 — merge por-recipient + render; puede degradar a invalid.
    const declaredKeys = Object.keys(template.variables);
    const valid: ValidateExternalBulkValidRecipientDto[] = [];
    const invalid: ValidateExternalBulkInvalidRecipientDto[] = [...invalidFromMatch];

    for (const candidate of candidates) {
      const merged = { ...globalVariables, ...(candidate.rawVariables ?? {}) };
      const missing = declaredKeys.filter((k) => merged[k] === undefined || merged[k] === '');
      if (missing.length > 0) {
        invalid.push({
          input: candidate.rawPhone,
          reason: 'variables_faltantes',
          missingVariables: [...missing].sort(),
        });
        continue;
      }
      // fix wave F1 (F12) — SOLO las keys DECLARADAS por el template viajan.
      // Las extra se siguen ACEPTANDO (VAL-10 lo exige) pero se DESCARTAN acá,
      // que es el único punto donde entran al sistema: el mapa que se persiste
      // en el preview es el que `SendExternalBulk` copia a
      // `CampaignRecipient.variables`, y `SendCampaign` lo spreadea entero
      // hacia `TwilioContentGateway` — una key basura del caller terminaba
      // serializada en el request al proveedor. Mismo mapa para el render, la
      // respuesta y el `payloadHash`: una sola verdad.
      const declared = pickDeclared(merged, declaredKeys);
      valid.push({
        phone: candidate.phoneE164,
        name: candidate.name,
        variables: declared,
        renderedMessage: renderTemplateBody(template.body, declared),
      });
    }

    // 8 — VAL-3 scenario 2 — nada que ofrecer, no se persiste un preview vacío.
    if (valid.length === 0) {
      throw new EmptyRecipientsError();
    }

    // 9 — VAL-6/VAL-7 — caps. maxPerRequest primero (barato, en memoria);
    // el diario recién si el per-request pasó (evita una query innecesaria).
    if (valid.length > config.maxPerRequest) {
      throw new CapExceededError({
        limit: 'perRequest',
        maxPerRequest: config.maxPerRequest,
        received: valid.length,
      });
    }
    const remainingToday = await this.resolveRemainingToday(config.maxPerDay);
    if (valid.length > remainingToday) {
      throw new CapExceededError({ limit: 'perDay', remainingToday });
    }

    // 9.5 — CRÉDITO (ADVISORY, twilio-credit-guard D4.b). Después de los
    // caps: si el lote ni siquiera entra por cantidad, el número de plata es
    // ruido. NUNCA voltea el request — cualquier falla (balance, rates)
    // degrada a `unknown`, jamás lanza.
    // fix wave F1 (F7) — con la perilla del guard APAGADA no se mide nada: ni
    // tarifas ni saldo (cero requests al proveedor). El bloque viaja `unknown`
    // con una warning PROPIA — "no se midió" no es lo mismo que "no se pudo".
    const creditGuardEnabled = await this.resolveCreditGuardEnabled();
    const credit = creditGuardEnabled
      ? await this.resolveCredit(template.category, valid.length)
      : unmeasuredCredit(template.category);
    const warnings: ExternalBulkWarning[] = creditGuardEnabled
      ? creditWarnings(credit)
      : ['CREDIT_GUARD_DISABLED'];

    // 10 — VAL-8 — persist preview con hash canónico + expiración de 15 min.
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + PREVIEW_TTL_MS).toISOString();
    const payloadHash = externalBulkPayloadHash({
      templateName: template.friendlyName,
      variables: globalVariables,
      chatwootLabel,
      // D5 — el `send` re-hashea desde lo PERSISTIDO: válidos con su E.164 +
      // variables MERGEADAS, inválidos con solo su `input` (sin variables) —
      // exactamente `preview.recipients` ∪ `preview.invalid[].input`.
      recipients: [
        ...valid.map((v) => ({ phone: v.phone, name: v.name, variables: v.variables })),
        ...invalid.map((i) => ({ phone: i.input })),
      ],
    });

    const preview = await this.previewRepo.create({
      payloadHash,
      templateRef: template.contentSid,
      templateName: template.friendlyName,
      variables: globalVariables,
      chatwootLabel,
      recipients: valid.map((v) => ({
        phoneE164: v.phone,
        // Re-derivado del E.164 ya reconstruido (lossy en el mismo sentido que
        // `matchManualContacts`'s `raw.phoneNormalized`) — evita colar un campo
        // interno en el DTO de salida (D12 no lo expone).
        phoneNormalized: normalizePhone(v.phone) ?? v.phone,
        name: v.name,
        variables: v.variables,
      })),
      invalid: invalid.map((i) => ({
        input: i.input,
        reason: i.reason,
        ...(i.missingVariables ? { missingVariables: i.missingVariables } : {}),
      })),
      validCount: valid.length,
      invalidCount: invalid.length,
      credit,
      expiresAt,
    });

    // D9 — purga best-effort, NUNCA voltea la respuesta.
    await this.bestEffortPurge();

    const counts = {
      received: input.recipients.length,
      valid: valid.length,
      invalid: invalid.length,
      optedOut: invalid.filter((i) => i.reason === 'opt_out').length,
      duplicated: invalid.filter((i) => i.reason === 'duplicado').length,
    };

    return {
      previewId: preview.id,
      expiresAt: preview.expiresAt,
      renderedMessage: valid[0]?.renderedMessage ?? '',
      counts,
      valid,
      invalid,
      caps: { maxPerRequest: config.maxPerRequest, maxPerDay: config.maxPerDay, remainingToday },
      credit,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  /**
   * twilio-credit-guard (D4.b) — ADVISORY: cualquier falla (balance, rates,
   * parseo) degrada a `unknown`, jamás tira. `validate` NUNCA se convierte en
   * un error por crédito insuficiente/inalcanzable (CG-VAL-1) — eso es
   * exclusivo del gate fail-closed de `SendExternalBulk` (D4.c).
   */
  private async resolveCredit(category: string | undefined, validCount: number): Promise<MessagingCreditDto> {
    // fix wave F1 (F4) — el fallback a `MESSAGING_RATES_CONFIG_DEFAULTS` SE
    // ELIMINÓ. Si la DB de tarifas se cae, mostrar un costo calculado con
    // tarifas INVENTADAS es peor que decir "no sé": quien lo lee (la card FE,
    // la IA que consume la API externa) lo toma por el precio real. `rates:null`
    // degrada a `unknown`, que ya emite la warning CREDIT_UNAVAILABLE.
    let rates: MessagingRatesConfig | null = null;
    try {
      rates = await this.ratesRepo.get();
    } catch {
      rates = null;
    }
    let balance = null;
    try {
      balance = await this.creditPort.getBalance();
    } catch {
      balance = null;
    }
    // fix wave F1 (F6) — `estimateMessagingCost` ya es total (el overflow
    // degrada adentro), pero este camino es ADVISORY por contrato: NUNCA puede
    // voltear un 200. El try es el cinturón sobre los tiradores.
    try {
      return estimateMessagingCost({ category, validCount, rates, balance });
    } catch {
      return unmeasuredCredit(category);
    }
  }

  /**
   * fix wave F1 (F7) — al REVÉS del kill-switch: fila ausente o repo caído
   * resuelven a ON. Una protección no se apaga sola.
   */
  private async resolveCreditGuardEnabled(): Promise<boolean> {
    try {
      const flag = await this.featureFlags.get(CREDIT_GUARD_FLAG_KEY);
      return flag ? flag.enabled === true : true;
    } catch {
      return true;
    }
  }

  /** KS-1 — fail-safe: cualquier error del repo de flags resuelve a OFF, NUNCA a ON. */
  private async resolveFlagEnabled(): Promise<boolean> {
    try {
      return (await this.featureFlags.get(FEATURE_FLAG_KEY))?.enabled === true;
    } catch {
      return false;
    }
  }

  /** VAL-5 — cualquier falla de Chatwoot (red/timeout/4xx/5xx) → 503, nunca aceptado a ciegas. */
  private async assertLabelExists(label: string): Promise<void> {
    let labels;
    try {
      labels = await this.chatwootGateway.listAccountLabels();
    } catch {
      throw new ChatwootUnavailableError();
    }
    if (!labels.some((l) => l.title === label)) {
      throw new ChatwootLabelNotFoundError(label);
    }
  }

  /**
   * VAL-2 — clasifica CADA recipient del wire: sin_telefono / telefono_invalido /
   * opt_out (exacto vía `matchManualContacts` O por sufijo) / duplicado
   * (intra-batch, por E.164), o un candidato sobreviviente para el merge de
   * variables (paso 7). `non_mobile` YA NO se emite (fix wave F3, S1) — un
   * NSN AR de 10 dígitos limpio es móvil, no fijo (ver `classifyArPhone`).
   */
  private async classifyRecipients(recipients: ValidateExternalBulkInput['recipients']): Promise<{
    candidates: Array<{
      rawPhone: string;
      phoneE164: string;
      phoneNormalized: string;
      name: string;
      rawVariables: Record<string, string> | undefined;
    }>;
    invalid: ValidateExternalBulkInvalidRecipientDto[];
  }> {
    const invalid: ValidateExternalBulkInvalidRecipientDto[] = [];
    const candidates: Array<{
      rawPhone: string;
      phoneE164: string;
      phoneNormalized: string;
      name: string;
      rawVariables: Record<string, string> | undefined;
    }> = [];

    // sin_telefono se resuelve ACÁ (no se manda a matchManualContacts): con
    // phone==='' el name (default D4.b) también sería '', y matchManualContacts
    // devolvería 'sin_nombre' primero — reason que NO existe en el contrato D12.
    const withPhone = recipients.filter((r) => {
      if (r.phone) return true;
      invalid.push({ input: r.phone ?? '', reason: 'sin_telefono' });
      return false;
    });

    const contacts: ManualContactInput[] = withPhone.map((r) => ({
      name: r.name && r.name.length > 0 ? r.name : r.phone, // D4.b — crudo, no el E164.
      phone: r.phone,
    }));
    const resolutions = await matchManualContacts(contacts, this.segmentSource);

    const seenE164 = new Set<string>();
    resolutions.forEach((res: ManualContactResolution, i: number) => {
      const original = withPhone[i];

      if (res.kind === 'excluded') {
        // 'sin_nombre' es inalcanzable (name siempre no-vacío acá, D4.b); solo
        // 'sin_telefono'/'telefono_invalido'/'opt_out' pueden llegar de hecho.
        const reason: ExternalBulkInvalidReason =
          res.reason === 'sin_telefono' || res.reason === 'telefono_invalido' || res.reason === 'opt_out'
            ? res.reason
            : 'telefono_invalido';
        invalid.push({ input: res.phone, reason });
        return;
      }

      let phoneE164: string;
      let phoneNormalized: string;
      let name: string;
      if (res.kind === 'linked') {
        if (res.candidate.whatsappOptOutAt != null) {
          invalid.push({ input: original.phone, reason: 'opt_out' });
          return;
        }
        const e164 = toWhatsAppE164(res.candidate.phone);
        const normalized = normalizePhone(res.candidate.phone);
        if (e164 === null || normalized === null) {
          invalid.push({ input: original.phone, reason: 'telefono_invalido' });
          return;
        }
        phoneE164 = e164;
        phoneNormalized = normalized;
        name = res.contactName;
      } else {
        phoneE164 = res.phoneE164;
        phoneNormalized = res.phoneNormalized;
        name = res.name;
      }

      // El marcador de móvil se juzga sobre lo que el CALLER tipeó (D4.b),
      // no sobre `Client.phone` — un `linked` matchea por clave normalizada
      // (lossy), pero lo que decide "¿esto es un móvil?" es el crudo recibido.
      // fix wave F1 (F11) — un extranjero (o un crudo que no reconstruye un NSN
      // AR) es `telefono_invalido` — decir "es un fijo" de un celular
      // brasileño es mentira, y el estado anterior lo dejaba pasar como móvil
      // AR reconstruido a otro número.
      // fix wave F3 (S1, smoke en vivo) — ya NO hay tercer resultado
      // `non_mobile`: `classifyArPhone` es `mobile` o `invalid`, punto.
      if (!classifyArPhone(original.phone)) {
        invalid.push({ input: original.phone, reason: 'telefono_invalido' });
        return;
      }

      if (seenE164.has(phoneE164)) {
        invalid.push({ input: original.phone, reason: 'duplicado' });
        return;
      }
      seenE164.add(phoneE164);

      candidates.push({ rawPhone: original.phone, phoneE164, phoneNormalized, name, rawVariables: original.variables });
    });

    return { candidates, invalid };
  }

  /** VAL-7/D6 — cupo diario sobre lo REALMENTE enviado, día calendario Argentina. */
  private async resolveRemainingToday(maxPerDay: number): Promise<number> {
    const user = await this.rbacUserRepo.findByLogin(API_MESSAGING_USER_LOGIN);
    if (!user) {
      throw new ReporterUnavailableError();
    }
    const since = dayStartArt(this.now());
    const sentToday = await this.campaignRepo.countAuthorizedRecipientsByCreatorSince(user.id, since);
    return Math.max(0, maxPerDay - sentToday);
  }

  /** D9 — purga best-effort, JAMÁS voltea el request. */
  private async bestEffortPurge(): Promise<void> {
    try {
      const before = new Date(this.now().getTime() - PURGE_HORIZON_MS);
      await this.previewRepo.deleteExpiredBefore(before, PURGE_LIMIT);
    } catch {
      // best-effort — un fallo de purga no debe voltear un `validate` exitoso.
    }
  }
}

/**
 * twilio-credit-guard (CG-VAL-1) — deriva `warnings` del `credit` ya
 * calculado. `unknown` gana sobre `sufficient:false` (un balance inalcanzable
 * NO es lo mismo que "no alcanza") — un lote nunca reporta las DOS a la vez.
 * Array vacío ⇒ el caller lo omite del wire (D4.b, "warnings ausente cuando
 * está vacío").
 */
/**
 * fix wave F1 (F7/F8) — bloque `credit` HONESTO para "no se midió": ningún
 * número, `unknown:true`, `sufficient:false`. Se usa con el guard apagado y
 * como último recurso si el estimador llegara a tirar.
 */
function unmeasuredCredit(category: string | undefined): MessagingCreditDto {
  return estimateMessagingCost({ category, validCount: 0, rates: null, balance: null });
}

function creditWarnings(credit: MessagingCreditDto): ExternalBulkWarning[] {
  if (credit.unknown) return ['CREDIT_UNAVAILABLE'];
  if (!credit.sufficient) return ['INSUFFICIENT_CREDIT'];
  return [];
}

// ─── Helpers puros (VAL-1/VAL-2/D4.d/D6) ───────────────────────────────────

function assertValidShape(input: ValidateExternalBulkInput): void {
  if (!Array.isArray(input.recipients) || input.recipients.length === 0) {
    throw new ExternalBulkValidationError('recipients must be a non-empty array');
  }
  for (const r of input.recipients) {
    if (typeof r !== 'object' || r === null || typeof r.phone !== 'string') {
      throw new ExternalBulkValidationError('each recipient must have a string phone');
    }
  }
  const templateRef = typeof input.templateRef === 'string' ? input.templateRef.trim() : '';
  const templateName = typeof input.templateName === 'string' ? input.templateName.trim() : '';
  if (!templateRef && !templateName) {
    throw new ExternalBulkValidationError('templateRef or templateName is required');
  }
}

/** D4.d — `templateRef` (contentSid EXACTO) tiene prioridad; si no vino, resuelve por `friendlyName` (ambiguo ⇒ undefined). */
function resolveTemplate(
  templates: TemplateDto[],
  templateRef: string | undefined,
  templateName: string | undefined,
): TemplateDto | undefined {
  if (templateRef) {
    return templates.find((t) => t.contentSid === templateRef);
  }
  if (templateName) {
    const matches = templates.filter((t) => t.friendlyName === templateName);
    return matches.length === 1 ? matches[0] : undefined;
  }
  return undefined;
}

/**
 * fix wave F1 (F12) — proyecta `merged` sobre las keys DECLARADAS por el
 * template. Pura, total; orden de keys = el del template (determinístico para
 * el hash canónico, que igual re-ordena por su cuenta, D5).
 */
function pickDeclared(merged: Record<string, string>, declaredKeys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of declaredKeys) {
    const v = merged[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * VAL-2 — clasifica el crudo que TIPEÓ el caller: `true` (móvil AR enviable) /
 * `false` (no es un número AR reconstruible). Pura, total — nunca throws.
 *
 * ── fix wave F1 (finding F11): NÚMERO EQUIVOCADO ────────────────────────────
 * La versión anterior (`hasArMobileMarker`) devolvía `true` para CUALQUIER
 * crudo de 12 dígitos, asumiendo el formato local `[área][15][abonado]`. Pero
 * un móvil EXTRANJERO de 12 dígitos cuyo "15" cae, por casualidad, en un borde
 * de área AR válido pasa ese test y `toWhatsAppE164` lo "reconstruye" como un
 * `+549…` que NO es el número del caller: Colombia `+57 315 234 5678` →
 * `+5495732345678`. Eso es un envío a un tercero, con los datos personales de
 * otro. Un falso negativo acá cuesta un destinatario no contactado; un falso
 * positivo cuesta un mensaje al número equivocado — el sesgo va a `invalid`.
 *
 * La discriminación es el FORMATO del crudo, no su longitud: si el caller
 * escribió el número en forma INTERNACIONAL explícita (`+` o el prefijo de
 * acceso `00`), el país DEBE ser 54 — cualquier otro es `invalid`, jamás se
 * cae al `+549`. Sin marca internacional se aplican las reglas del discado
 * NACIONAL argentino de siempre (troncal `0`, "9" móvil, "15" local).
 *
 * ── fix wave F3 (finding S1, smoke en vivo): NÚMERO RECHAZADO DE MÁS ────────
 * `{"phone":"1178547218"}` (LIVE) volvía `non_mobile` acá — un NSN de 10
 * dígitos LIMPIO, sin "9" ni "15" — y `validate` lo excluía (422
 * EMPTY_RECIPIENTS si era el único recipient), pero `toWhatsAppE164` (el
 * mismo motor que usa `send`) SIEMPRE lo trató como móvil (`+549<nsn>`): en
 * Argentina el "9"/"15" son artefactos del DISCADO, no parte del número — la
 * forma [área][abonado] de 10 dígitos ES la forma canónica del móvil.
 * `validate` rechazaba lo que `send` hubiera aceptado igual. Ahora es un
 * wrapper FINO y CONSISTENTE con `toWhatsAppE164`: mobile ssi (a) no es un
 * extranjero explícito (regla intacta arriba) y (b) `toWhatsAppE164(raw)` no
 * da `null` — la MISMA función, la MISMA verdad. Ya no hay tercer resultado
 * `non_mobile`; el literal sigue vivo en `ExternalBulkInvalidReason` (D12)
 * por estabilidad de contrato de wire, pero el use case ya no lo emite.
 */
function classifyArPhone(raw: string): boolean {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 0) return false;

  // ¿El caller declaró un número INTERNACIONAL? ("+…" o el prefijo "00…").
  const explicitInternational = trimmed.startsWith('+') || digits.startsWith('00');
  const digitsAfterAccessPrefix = digits.startsWith('00') ? digits.slice(2) : digits;
  if (explicitInternational && !digitsAfterAccessPrefix.startsWith('54')) {
    // País distinto de Argentina — NUNCA reconstruible como `+549…`.
    return false;
  }

  return toWhatsAppE164(raw) !== null;
}

/** D6 — inicio del día calendario Argentina (00:00 ART = 03:00 UTC), sin `Intl`. */
function dayStartArt(now: Date): Date {
  const dateKey = toArgentinaDateKey(now.toISOString());
  return new Date(`${dateKey}T03:00:00.000Z`);
}
