import type { CampaignRepository } from '@domain/ports/CampaignRepository';
import type { CampaignSegmentSource, ManualRecipientSource } from '@domain/ports/CustomerRepository';
import type { TemplateMessagingPort } from '@domain/ports/TemplateMessagingPort';
import type { CreateCampaignInput, CreateCampaignOutput } from '@application/dto/messaging-bulk.dto';
import {
  TemplateNotApprovedError,
  MissingTemplateVariablesError,
  EmptySegmentError,
} from '@domain/errors/messaging-bulk';
import { assertHasRecipients } from './assertHasRecipients';
import { resolveCombinedRecipients, normalizeManualClientIds } from './resolveCombinedRecipients';

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
  ) {}

  async execute(input: CreateCampaignInput): Promise<CreateCampaignOutput> {
    // manual-recipients (MAN-1) — lista manual normalizada (dedup + sin vacíos).
    const manualClientIds = normalizeManualClientIds(input.manualClientIds);

    // MAN-2 (extiende FIX-8) — una campaña es válida con segmento filtrado O lista
    // manual no vacía; se rechaza ANTES de efectos SOLO si ambos están vacíos.
    assertHasRecipients(input.segment, manualClientIds);

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

    // MAN-1..MAN-4 — resuelve la UNIÓN (segmento ∪ manuales) deduplicada por
    // clientId. Fail-loud (MAN-3) si algún manualClientId no existe; compliance
    // (opt-out/teléfono/dedup) enforced por resolveRecipients en ambos sets.
    const { resolved } = await resolveCombinedRecipients({
      segment: input.segment,
      manualClientIds,
      segmentSource: this.segmentSource,
      manualRecipientSource: this.manualRecipientSource,
    });

    // CAMP-4 — cero destinatarios (segmento + manual resueltos a nada) se rechaza,
    // evita campañas fantasma.
    if (resolved.length === 0) {
      throw new EmptySegmentError();
    }

    const campaign = await this.campaignRepo.create({
      name: input.name,
      templateRef: input.templateRef,
      templateName: input.templateName ?? template.friendlyName,
      // messaging-bulk-inbox (F1) — captura el body de texto del template (TemplateDto.body,
      // '' si el proveedor no declaró texto plano) para renderizar el mensaje real al proyectar.
      templateBody: template.body,
      segment: input.segment,
      variableSpec: input.variablesMap,
      total: resolved.length,
      createdById: input.createdById,
    });

    await this.campaignRepo.bulkCreateRecipients(
      campaign.id,
      resolved.map((r) => ({
        clientId: r.clientId,
        phoneNormalized: r.phoneNormalized,
        phoneE164: r.phoneE164,
      })),
    );

    return { campaignId: campaign.id, total: campaign.total, status: 'pending' };
  }
}
