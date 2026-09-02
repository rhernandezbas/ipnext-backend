import type { CampaignRepository } from '@domain/ports/CampaignRepository';
import type { CampaignSegmentSource, ManualRecipientSource } from '@domain/ports/CustomerRepository';
import type { TemplateMessagingPort } from '@domain/ports/TemplateMessagingPort';
import type { TaskRecipientSource } from '@domain/ports/TaskRecipientSource';
import type { TaskStageRecipientConfigRepository } from '@domain/ports/TaskStageRecipientConfigRepository';
import type { TaskStageTransitionConfigRepository } from '@domain/ports/TaskStageTransitionConfigRepository';
import type { CreateCampaignInput, CreateCampaignOutput } from '@application/dto/messaging-bulk.dto';
import {
  TemplateNotApprovedError,
  MissingTemplateVariablesError,
  EmptySegmentError,
  BulkRecipientsNotPermittedError,
} from '@domain/errors/messaging-bulk';
import { forbiddenBulkTargets } from '@domain/services/bulkRecipientAuthorization';
import { assertHasRecipients } from './assertHasRecipients';
import { assertTaskStagesEligible } from './assertTaskStagesEligible';
import { resolveCombinedRecipients, normalizeManualClientIds, normalizeManualContacts } from './resolveCombinedRecipients';

/**
 * messaging-bulk (F2, CAMP-1..CAMP-4) — crea una campaña en `pending` SIN
 * disparar el envío (el envío es un paso posterior y explícito, ver SEND-*,
 * Batch 4).
 *
 * Constructor 3-args (tasks.md contradicción #2 — el snippet de wiring de
 * design §7 instanciaba `CreateCampaign(campaignRepo, customerRepo)`, 2 args,
 * sin el `templatePort` que CAMP-2 necesita para validar `templateRef`
 * aprobado; Batch 7 corrige el wiring real, no copia el snippet tal cual).
 *
 * `variablesMap` (contradicción #3): valida PRESENCIA DE KEYS contra
 * `TemplateDto.variables` — cada entrada preserva `{source, value?}`, NO es
 * un mapa de valores fijos idénticos para todos los destinatarios (eso
 * rompería la personalización — `SendCampaign`, Batch 4, resuelve el valor
 * real POR-DESTINATARIO).
 */
export class CreateCampaign {
  constructor(
    private readonly campaignRepo: CampaignRepository,
    private readonly segmentSource: CampaignSegmentSource,
    private readonly templatePort: TemplateMessagingPort,
    // manual-recipients (MAN-1) — OPCIONAL para no romper la aridad de los tests
    // ya verdes (3 args). El wiring real (app.ts) SIEMPRE lo inyecta.
    private readonly manualRecipientSource?: ManualRecipientSource,
    // bulk-task-recipients (D3, D5) — 2 args OPCIONALES nuevos AL FINAL (molde
    // `manualRecipientSource`, no rompen la aridad de los tests ya verdes).
    private readonly taskRecipientSource?: TaskRecipientSource,
    private readonly taskStageConfigRepo?: TaskStageRecipientConfigRepository,
    // bulk-task-stage-transition — config del estado resultante global (snapshot al create).
    private readonly taskTransitionConfig?: TaskStageTransitionConfigRepository,
  ) {}

  async execute(input: CreateCampaignInput): Promise<CreateCampaignOutput> {
    // manual-recipients (MAN-1) — lista manual normalizada (dedup + sin vacíos).
    const manualClientIds = normalizeManualClientIds(input.manualClientIds);
    // bulk-csv-recipients (CSV-1) — 4to dominio normalizado (trim + descarta ruido).
    const manualContacts = normalizeManualContacts(input.manualContacts);
    // bulk-task-recipients (TASK-1) — 5to dominio, PARALELO.
    const taskStageIds = input.taskStageIds ?? [];

    // MAN-2 (extiende FIX-8) — una campaña es válida con segmento filtrado, O lista
    // manual no vacía, O manualContacts no vacío, O taskStageIds no vacío; se
    // rechaza ANTES de efectos SOLO si los CUATRO están vacíos.
    assertHasRecipients(input.segment, manualClientIds, manualContacts, taskStageIds);
    // bulk-task-recipients (TASK-2, D3) — elegibilidad ANTES de resolver clientes
    // (guard de pre-vuelo, junto a assertHasRecipients — NO dentro del resolver).
    await assertTaskStagesEligible(taskStageIds, this.taskStageConfigRepo);

    // CAMP-2 — templateRef debe corresponder a un template approved. Un
    // templateRef inexistente en el proveedor se trata IGUAL que no-aprobado
    // (no hay evidencia de aprobación).
    const templates = await this.templatePort.listTemplates();
    const template = templates.find((t) => t.contentSid === input.templateRef);
    if (!template || template.approvalStatus !== 'approved') {
      throw new TemplateNotApprovedError(input.templateRef);
    }

    // CAMP-3 — TODAS las variables declaradas por el template deben estar
    // presentes como keys en variablesMap. Variables EXTRA no declaradas NO
    // bloquean la creación.
    const declaredVariableNames = Object.keys(template.variables);
    const missing = declaredVariableNames.filter((name) => !(name in input.variablesMap));
    if (missing.length > 0) {
      throw new MissingTemplateVariablesError(missing);
    }

    // MAN-1..MAN-4 + bulk-csv-recipients (CSV-1..CSV-4) + bulk-task-recipients
    // (TASK-1..TASK-9) — resuelve la UNIÓN (segmento ∪ manuales ∪ contactos CSV ∪
    // tarea) deduplicada por clientId Y por teléfono. Fail-loud (MAN-3) si algún
    // manualClientId no existe; compliance (opt-out/teléfono/dedup) enforced por
    // resolveRecipients/matchManualContacts. `resolved` (D7) se congela DEBAJO,
    // en `bulkCreateRecipients` — el envío jamás re-resuelve (TASK-8).
    const { resolved } = await resolveCombinedRecipients({
      segment: input.segment,
      manualClientIds,
      manualContacts,
      taskStageIds,
      segmentSource: this.segmentSource,
      manualRecipientSource: this.manualRecipientSource,
      taskRecipientSource: this.taskRecipientSource,
      taskTransitionConfig: this.taskTransitionConfig,
    });

    // CAMP-4 — cero destinatarios (segmento + manual resueltos a nada) se rechaza,
    // evita campañas fantasma.
    if (resolved.length === 0) {
      throw new EmptySegmentError();
    }

    // bulk-granular-perms — BLOQUEO: si el usuario no tiene permiso para ALGÚN
    // estado/tipo presente en la unión resuelta (todos los destinatarios: segmento
    // + nodo/AP + manuales + números), se rechaza la campaña completa (no se
    // filtra). super_admin trae `'*'` en el set → nunca prohíbe. `undefined` →
    // sin enforcement (la ruta SIEMPRE lo pasa en prod; es el borde de seguridad).
    if (input.allowedBulkActions !== undefined) {
      const allowed = input.allowedBulkActions instanceof Set
        ? input.allowedBulkActions
        : new Set(input.allowedBulkActions);
      const forbidden = forbiddenBulkTargets(allowed, resolved);
      if (forbidden.length > 0) {
        throw new BulkRecipientsNotPermittedError(forbidden);
      }
    }

    // bulk-granular-perms — snapshot de los estados presentes (distinct, SIN los
    // números crudos: esos van en `hasRawRecipients`) para el re-chequeo en el
    // envío (POST /:id/send), donde el sender puede ser otro usuario con menos
    // permisos que el creador.
    const recipientStatuses = [
      ...new Set(resolved.filter((r) => r.clientId !== null).map((r) => r.status)),
    ].sort((a, b) => a.localeCompare(b));
    const hasRawRecipients = resolved.some((r) => r.clientId === null);

    const campaign = await this.campaignRepo.create({
      name: input.name,
      templateRef: input.templateRef,
      templateName: input.templateName ?? template.friendlyName,
      // messaging-bulk-inbox (F1) — captura el body de texto del template (TemplateDto.body,
      // '' si el proveedor no declaró texto plano) para renderizar el mensaje real al proyectar.
      templateBody: template.body,
      // campaign-chatwoot-label (CLBL-6) — pass-through PURO (Decisión D): CERO
      // validación/re-consulta contra el catálogo de Chatwoot acá. Ausente → null.
      chatwootLabel: input.chatwootLabel ?? null,
      segment: input.segment,
      variableSpec: input.variablesMap,
      recipientStatuses,
      hasRawRecipients,
      total: resolved.length,
      createdById: input.createdById,
      // external-bulk-messaging (D1.a) — pass-through puro; ausente ⇒ `null`
      // (comportamiento actual de la UI admin, intacto).
      externalIdempotencyKey: input.externalIdempotencyKey ?? null,
    });

    await this.campaignRepo.bulkCreateRecipients(
      campaign.id,
      resolved.map((r) => ({
        clientId: r.clientId,
        // bulk-csv-recipients (D1/PER-1) — `contactName` SOLO tiene sentido en
        // filas sin `Client` (`clientId: null`, CSV-3); un vinculado (segmento/
        // manual/CSV-matched) siempre resuelve el nombre desde `Client.name` fresco.
        contactName: r.clientId === null ? r.name : null,
        phoneNormalized: r.phoneNormalized,
        phoneE164: r.phoneE164,
        // bulk-task-stage-transition — snapshot per-tarea (solo filas source:'task').
        taskId: r.taskId ?? null,
        taskFromStageId: r.taskFromStageId ?? null,
        taskResultingStageId: r.taskResultingStageId ?? null,
        // external-bulk-messaging (D4.e punto 6) — literales POR-RECIPIENT del
        // caller externo; `undefined` (todo dominio que no lo usa) → `null`.
        variables: r.variables ?? null,
      })),
    );

    return { campaignId: campaign.id, total: campaign.total, status: 'pending' };
  }
}
