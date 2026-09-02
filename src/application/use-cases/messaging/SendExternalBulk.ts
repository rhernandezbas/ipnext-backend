import type { ExternalBulkPreviewRepository } from '@domain/ports/ExternalBulkPreviewRepository';
import type { ExternalBulkMessagingConfigRepository } from '@domain/ports/ExternalBulkMessagingConfigRepository';
import type { CampaignRepository } from '@domain/ports/CampaignRepository';
import type { TemplateMessagingPort } from '@domain/ports/TemplateMessagingPort';
import type { ChatwootGateway } from '@domain/ports/ChatwootGateway';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { CampaignStarter } from '@domain/ports/CampaignStarter';
import type { Campaign, CampaignVariableSpec } from '@domain/entities/campaign';
import type { ExternalBulkPreview } from '@domain/entities/externalBulkPreview';
import type { SendExternalBulkInput, SendExternalBulkOutput } from '@application/dto/external-bulk-messaging.dto';
import type { ManualContactDto } from '@application/dto/messaging-bulk.dto';
import { CreateCampaign } from './CreateCampaign';
import {
  FeatureExternalBulkDisabledError,
  ExternalBulkValidationError,
  CapExceededError,
  ChatwootLabelNotFoundError,
  PreviewNotFoundError,
  PreviewExpiredError,
  PreviewAlreadyConsumedError,
  PreviewPayloadMismatchError,
  IdempotencyKeyConflictError,
  CampaignRunnerBusyError,
  ReporterUnavailableError,
} from '@domain/errors/external-bulk-messaging';
import { TemplateNotApprovedError } from '@domain/errors/messaging-bulk';
import { ChatwootUnavailableError } from '@domain/errors/messaging';
import { externalBulkPayloadHash } from './externalBulkPayloadHash';
import { toArgentinaDateKey } from './reportsTimezone';
import { API_MESSAGING_USER_LOGIN } from '@domain/constants/machineUsers';
import { UniqueConstraintViolationError } from '@domain/errors/persistence';
import { BULK_NUMBERS_ACTION, BULK_STATUS_ACTION } from '@domain/services/bulkRecipientAuthorization';

const FEATURE_FLAG_KEY = 'messaging-external-bulk-enabled';
const RUNNER_BUSY_RETRY_AFTER_SECONDS = 60;

/**
 * fix wave F1 (F9) — allowlist EXPLICITO para el camino externo. NO incluye el
 * sentinel `'*'` de super_admin: con el gate prendido, un estado de cliente que
 * todavia no tiene accion RBAC mapeada bloquea la campana (bloqueo defensivo de
 * `forbiddenBulkTargets`) en vez de enviarse en silencio.
 */
const EXTERNAL_BULK_ALLOWED_ACTIONS: readonly string[] = Object.freeze([
  BULK_NUMBERS_ACTION,
  ...Object.values(BULK_STATUS_ACTION),
]);

/** fix wave F1 (F12) — proyecta un mapa de variables sobre las keys DECLARADAS por el template. */
function pickDeclared(
  variables: Record<string, string> | null | undefined,
  declaredKeys: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of declaredKeys) {
    const v = variables?.[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * external-bulk-messaging (Batch 3, SEND-1..SEND-10) — segundo paso del flujo
 * M2M de 2 pasos: consume un `ExternalBulkPreview` YA validado, re-valida el
 * estado de AHORA (D0 paso 3), crea la `Campaign` vía `CreateCampaign` (REUSO,
 * sin tocar su spec) y arranca `CampaignRunner` (por interfaz estructural
 * `CampaignStarter`, D4.a).
 *
 * Orden (design.md D0, molde GUARD-0 de `SendTemplateMessage.ts:116`):
 *   0. forma del input (SEND-1)
 *   0.5 GUARD-0 — `campaignRepo.findByExternalIdempotencyKey(key)` ANTES de
 *       cualquier otro guard/side-effect (SEND-6/SEND-7, mismo molde que
 *       `SendTemplateMessage`'s idempotency fast-path — KS-1 exige el flag
 *       "antes de cualquier otra lógica de NEGOCIO nueva", el guard-0 es
 *       dedup, no lógica de negocio nueva).
 *   1. flag (KS-1, fail-safe OFF)
 *   2. preview lookup + ciclo de vida (SEND-2)
 *   3. re-hash desde el preview PERSISTIDO vs `payloadHash` (SEND-3)
 *   4. re-validación completa (pasos 4-7 de validate, D0): template aprobado,
 *      opt-out, label de Chatwoot, caps — contra el estado de AHORA (SEND-4)
 *   5. `CreateCampaign` (SEND-5, SEND-10)
 *   6. `previewRepo.markConsumed` DESPUÉS de crear (D8 — orden obligatorio)
 *   7. `campaignStarter.start` (SEND-8/SEND-9)
 */
export class SendExternalBulk {
  constructor(
    private readonly previewRepo: ExternalBulkPreviewRepository,
    private readonly configRepo: ExternalBulkMessagingConfigRepository,
    private readonly campaignRepo: CampaignRepository,
    private readonly templatePort: TemplateMessagingPort,
    private readonly chatwootGateway: ChatwootGateway,
    private readonly featureFlags: FeatureFlagRepository,
    private readonly rbacUserRepo: RbacUserRepository,
    private readonly createCampaign: CreateCampaign,
    private readonly campaignStarter: CampaignStarter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: SendExternalBulkInput, idempotencyKey: string | undefined): Promise<SendExternalBulkOutput> {
    // 0 — SEND-1, forma del input. CERO llamadas downstream si falla.
    if (!input.previewId || typeof input.previewId !== 'string') {
      throw new ExternalBulkValidationError('previewId is required');
    }
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      throw new ExternalBulkValidationError('Idempotency-Key header is required');
    }

    // 0.5 — GUARD-0 (SEND-6/SEND-7, molde SendTemplateMessage.ts:116).
    const existingCampaign = await this.campaignRepo.findByExternalIdempotencyKey(idempotencyKey);
    if (existingCampaign) {
      return this.replay(existingCampaign, input.previewId);
    }

    // 1 — KS-1, fail-safe a OFF.
    if (!(await this.resolveFlagEnabled())) {
      throw new FeatureExternalBulkDisabledError();
    }

    // 2 — SEND-2, ciclo de vida del preview.
    const preview = await this.previewRepo.findById(input.previewId);
    if (!preview) {
      throw new PreviewNotFoundError(input.previewId);
    }
    // fix wave F1 (F10) — ORDEN: vencido (410) ANTES que consumido (409), tal
    // cual lo enumera SEND-2. Un preview vencido Y consumido devolvía 409, que
    // le sugiere al caller "usá otra key" cuando la verdad es "ese preview ya
    // no sirve para nadie" (410). El vencimiento es la condición más fuerte.
    if (new Date(preview.expiresAt).getTime() < this.now().getTime()) {
      throw new PreviewExpiredError(input.previewId);
    }
    if (preview.consumedAt !== null) {
      throw new PreviewAlreadyConsumedError(input.previewId);
    }

    // 3 — SEND-3, re-hash desde el preview PERSISTIDO.
    this.assertPayloadUnchanged(preview);

    // 4 — SEND-4, re-validación completa (D0 pasos 4-7, contra el estado de AHORA).
    const template = await this.assertTemplateApproved(preview.templateRef);
    if (preview.chatwootLabel) {
      await this.assertLabelExists(preview.chatwootLabel);
    }
    const config = await this.configRepo.get();
    if (preview.recipients.length > config.maxPerRequest) {
      throw new CapExceededError({
        limit: 'perRequest',
        maxPerRequest: config.maxPerRequest,
        received: preview.recipients.length,
      });
    }
    const apiMessagingUserId = await this.resolveApiMessagingUserId();
    const remainingToday = await this.resolveRemainingToday(apiMessagingUserId, config.maxPerDay);
    if (preview.recipients.length > remainingToday) {
      throw new CapExceededError({ limit: 'perDay', remainingToday });
    }

    // 5 — SEND-5/SEND-10, crea la Campaign (REUSO de CreateCampaign, sin tocar su
    // spec). `manualContacts` pasa TODOS los recipients del preview tal cual —
    // `CreateCampaign` (vía `resolveCombinedRecipients`/`matchManualContacts`, el
    // MISMO paso 5 de validate) los re-resuelve contra el `CampaignSegmentSource`
    // VIVO y excluye opt-outs por su cuenta (SEND-4 "opt-out re-chequeado"): un
    // segundo chequeo de opt-out ACÁ sería una segunda fuente de verdad que
    // puede divergir de la primera sin ganar nada — confirmado con un probe de
    // mutación (memoria `fixtures-degenerados-ocultan-invariantes`): un chequeo
    // propio de opt-out se implementó primero, y apagarlo a propósito NO rompió
    // ningún test — `CreateCampaign` ya lo cubre end-to-end.
    const declaredKeys = Object.keys(template.variables);
    const variableSpec: CampaignVariableSpec = Object.fromEntries(
      declaredKeys.map((k) => [k, { source: 'literal' as const, value: preview.variables[k] ?? '' }]),
    );
    // fix wave F1 (F12) — segundo filtro al conjunto DECLARADO. `validate` ya
    // lo aplica al persistir el preview; esto cubre un preview MUTADO en la DB
    // entre pasos (el mismo escenario que defiende el `payloadHash`) y, sobre
    // todo, cierra el camino por el que una key basura del caller llegaría al
    // proveedor: `SendCampaign` spreadea `recipient.variables` COMPLETO hacia
    // `TwilioContentGateway`, que serializa todo lo que reciba.
    const manualContacts: ManualContactDto[] = preview.recipients.map((r) => ({
      name: r.name && r.name.length > 0 ? r.name : r.phoneE164,
      phone: r.phoneE164,
      variables: pickDeclared(r.variables, declaredKeys),
    }));

    // fix wave F1 (F9) — `allowedBulkActions` EXPLÍCITO. Antes iba `undefined`,
    // y `CreateCampaign` documenta que eso significa "sin enforcement": el
    // camino externo era el ÚNICO que esquivaba `forbiddenBulkTargets`. El set
    // que se pasa es el más ancho que preserva el contrato (la API externa
    // manda NÚMEROS sueltos, que pueden o no vincular a un `Client` de
    // cualquier estado: acotarlo más rompería sends legítimos), pero NO es
    // `'*'`: con el gate PRENDIDO, un estado de cliente nuevo/desconocido —
    // uno que todavía no tiene acción RBAC mapeada — bloquea la campaña en vez
    // de enviarla, que es exactamente el bloqueo defensivo de
    // `forbiddenBulkTargets`. El límite real del caller M2M sigue siendo la key
    // dedicada + el kill-switch + los caps, no RBAC por estado.
    let created: { campaignId: string; total: number };
    try {
      created = await this.createCampaign.execute({
        name: `external-bulk:${preview.templateName}`,
        templateRef: preview.templateRef,
        templateName: preview.templateName,
        chatwootLabel: preview.chatwootLabel ?? undefined,
        segment: { statuses: [] },
        variablesMap: variableSpec,
        manualContacts,
        allowedBulkActions: [...EXTERNAL_BULK_ALLOWED_ACTIONS],
        createdById: apiMessagingUserId,
        externalIdempotencyKey: idempotencyKey,
      });
    } catch (err) {
      // fix wave F1 (F5) — BACKSTOP de carrera del `@unique`
      // `externalIdempotencyKey` (D1.a): dos `send` concurrentes con la MISMA
      // key que AMBOS pasaron el guard-0 chocan en el `create`. El perdedor NO
      // es un 500: re-lee la campaña GANADORA y devuelve la respuesta
      // idempotente de SEND-6, sin consumir el preview ni arrancar el runner
      // (de eso se ocupa el ganador, que está a mitad de camino).
      //
      // fix wave F2 (NEW-1) — el `field` SE CHEQUEA antes de asumir que esta
      // carrera es LA carrera de idempotencia: `Campaign` puede sumar otro
      // `@unique` el día de mañana (o `CreateCampaign` internamente puede
      // chocar contra el de `CampaignRecipient`), y ese caso NO tiene una
      // campaña ganadora para re-leer por esta key — es un error real que debe
      // subir como tal, no confundirse con SEND-6.
      if (err instanceof UniqueConstraintViolationError && err.field === 'externalIdempotencyKey') {
        const winner = await this.campaignRepo.findByExternalIdempotencyKey(idempotencyKey);
        if (winner) {
          return {
            campaignId: winner.id,
            accepted: true,
            total: winner.total,
            resumed: true,
            status: winner.status,
          };
        }
      }
      throw err;
    }

    // 6 — D8, orden OBLIGATORIO: markConsumed DESPUÉS de crear. Si pierde la
    // carrera (otro `send` ya consumió ESE previewId), la Campaign recién
    // creada queda huérfana → se marca `failed` (nunca se re-envía sola) y se
    // responde 409 — el preview no se puede re-consumir para ella.
    const consumed = await this.previewRepo.markConsumed(input.previewId, created.campaignId);
    if (!consumed) {
      await this.campaignRepo.update(created.campaignId, {
        status: 'failed',
        error: 'preview consumido por otro request',
      });
      throw new PreviewAlreadyConsumedError(input.previewId);
    }

    // 7 — SEND-8/SEND-9, arranca el runner.
    const startResult = await this.campaignStarter.start(created.campaignId);
    if (!startResult.accepted) {
      throw new CampaignRunnerBusyError(created.campaignId, RUNNER_BUSY_RETRY_AFTER_SECONDS);
    }

    // fix wave F1 (F6) — el `console.log` estructurado que vivia aca se
    // ELIMINO. Su unica razon de ser era compensar que la auditoria generica
    // registraba estos POST como `actorLogin:'anonymous'`; ahora el mount
    // adjunta el actor MAQUINA `api-messaging` (`machineActorMiddleware`) y
    // `auditMutationsMiddleware` deja una fila REAL, consultable desde
    // `GET /api/admin/audit-events` — un log a stdout no es auditoria (AUDIT-1).
    return { campaignId: created.campaignId, accepted: true, total: created.total };
  }

  /**
   * GUARD-0 hit — SEND-6 (replay, mismo previewId) o SEND-7 (conflicto, otro
   * previewId).
   *
   * ── fix wave F1 (findings F3.a/F3.b) ─────────────────────────────────────
   * (a) El flag SE RE-CHEQUEA acá. La versión anterior lo salteaba invocando el
   *     molde de `SendTemplateMessage` (guard-0 = "dedup, no lógica nueva"),
   *     pero esa analogía no aplica: ahí el fast-path DEVUELVE un mensaje ya
   *     enviado y no dispara NADA; acá llama `campaignStarter.start()`, que
   *     dispara envíos REALES. KS-1 no declara ninguna exención de replay, y un
   *     kill-switch que se puede esquivar reintentando con la misma key no es
   *     un kill-switch. Los CAPS, en cambio, NO se re-chequean: esos
   *     destinatarios ya quemaron cupo cuando la campaña se creó (D6 revisado,
   *     finding F2) — volver a contarlos los cobraría dos veces.
   * (b) El estado de la campaña MANDA. Antes se llamaba `start()` a ciegas:
   *     sobre una campaña `done`/`failed` eso la re-dispara. Ahora:
   *       done | failed  → respuesta idempotente `resumed:false` (SEND-6), sin
   *                        tocar el runner. NO es un error: el caller pidió "lo
   *                        que ya pasó con esta key", y eso es exactamente lo
   *                        que recibe, con el `status` para saberlo.
   *       running        → `resumed:true` sin `start()` (ya está corriendo; el
   *                        lock lo rebotaría con un 409 mentiroso).
   *       pending|paused → `start()` real (resume, SEND-8); ocupado ⇒ 409.
   */
  private async replay(campaign: Campaign, previewId: string): Promise<SendExternalBulkOutput> {
    // (a) KS-1 — fail-closed también en el replay.
    if (!(await this.resolveFlagEnabled())) {
      throw new FeatureExternalBulkDisabledError();
    }

    const preview = await this.previewRepo.findById(previewId);
    if (!preview || preview.campaignId !== campaign.id) {
      throw new IdempotencyKeyConflictError(previewId);
    }

    const base = { campaignId: campaign.id, accepted: true as const, total: campaign.total, status: campaign.status };

    // (b) una campaña TERMINADA no se re-arranca.
    if (campaign.status === 'done' || campaign.status === 'failed') {
      return { ...base, resumed: false };
    }
    if (campaign.status === 'running') {
      return { ...base, resumed: true };
    }

    const startResult = await this.campaignStarter.start(campaign.id);
    if (!startResult.accepted) {
      throw new CampaignRunnerBusyError(campaign.id, RUNNER_BUSY_RETRY_AFTER_SECONDS);
    }
    return { ...base, resumed: true };
  }

  /** KS-1 — fail-safe: cualquier error del repo de flags resuelve a OFF, NUNCA a ON. */
  private async resolveFlagEnabled(): Promise<boolean> {
    try {
      return (await this.featureFlags.get(FEATURE_FLAG_KEY))?.enabled === true;
    } catch {
      return false;
    }
  }

  /** SEND-3 — re-hash EXACTAMENTE reconstruible desde `preview.recipients` + `preview.invalid[].input` (D5). */
  private assertPayloadUnchanged(preview: ExternalBulkPreview): void {
    const recomputed = externalBulkPayloadHash({
      templateName: preview.templateName,
      variables: preview.variables,
      chatwootLabel: preview.chatwootLabel,
      recipients: [
        ...preview.recipients.map((r) => ({ phone: r.phoneE164, name: r.name, variables: r.variables })),
        ...preview.invalid.map((i) => ({ phone: i.input })),
      ],
    });
    if (recomputed !== preview.payloadHash) {
      throw new PreviewPayloadMismatchError(preview.id);
    }
  }

  /** SEND-4 (D0 paso 4) — template sigue existiendo y aprobado AHORA. */
  private async assertTemplateApproved(templateRef: string) {
    const templates = await this.templatePort.listTemplates();
    const template = templates.find((t) => t.contentSid === templateRef);
    if (!template || template.approvalStatus !== 'approved') {
      throw new TemplateNotApprovedError(templateRef);
    }
    return template;
  }

  /** SEND-4 (D0 paso 6) — label de Chatwoot re-chequeado contra el catálogo VIVO. */
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

  /** D2/D15 — resuelve el `RbacUser` `api-messaging`; ausente ⇒ plataforma mal provisionada (503). */
  private async resolveApiMessagingUserId(): Promise<string> {
    const user = await this.rbacUserRepo.findByLogin(API_MESSAGING_USER_LOGIN);
    if (!user) {
      throw new ReporterUnavailableError();
    }
    return user.id;
  }

  /** SEND-4 (D0 paso 7) — cupo diario re-leído FRESCO (CONFIG-3: puede haber cambiado desde el validate). */
  private async resolveRemainingToday(apiMessagingUserId: string, maxPerDay: number): Promise<number> {
    const since = dayStartArt(this.now());
    const sentToday = await this.campaignRepo.countAuthorizedRecipientsByCreatorSince(apiMessagingUserId, since);
    return Math.max(0, maxPerDay - sentToday);
  }
}

/** D6 — inicio del día calendario Argentina (00:00 ART = 03:00 UTC), sin `Intl`. Molde `ValidateExternalBulk`. */
function dayStartArt(now: Date): Date {
  const dateKey = toArgentinaDateKey(now.toISOString());
  return new Date(`${dateKey}T03:00:00.000Z`);
}
