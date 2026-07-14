import type { CampaignRepository } from '@domain/ports/CampaignRepository';
import type { CampaignSegmentSource } from '@domain/ports/CustomerRepository';
import type { TemplateMessagingPort } from '@domain/ports/TemplateMessagingPort';
import type { CreateCampaignInput, CreateCampaignOutput } from '@application/dto/messaging-bulk.dto';
import {
  TemplateNotApprovedError,
  MissingTemplateVariablesError,
  EmptySegmentError,
} from '@domain/errors/messaging-bulk';
import { resolveRecipients } from './resolveRecipients';
import { assertSegmentIsFiltered } from './assertSegmentIsFiltered';

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
  ) {}

  async execute(input: CreateCampaignInput): Promise<CreateCampaignOutput> {
    // FIX-8 — un segmento sin criterio apuntaría a TODA la base (buildSegmentWhere
    // → where:{}); se rechaza ANTES de cualquier efecto (mismo guard que Preview).
    assertSegmentIsFiltered(input.segment);

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

    // Re-resuelve el segmento con la MISMA lógica que PreviewCampaignSegment
    // (helper compartido resolveRecipients — SEG-2/SEG-3/SEG-4).
    const candidates = await this.segmentSource.listSegmentRecipients({
      statuses: input.segment.statuses,
      balanceMin: input.segment.balanceMin,
      balanceMax: input.segment.balanceMax,
    });
    const { resolved } = resolveRecipients(candidates);

    // CAMP-4 — segmento vacío se rechaza, evita campañas fantasma.
    if (resolved.length === 0) {
      throw new EmptySegmentError();
    }

    const campaign = await this.campaignRepo.create({
      name: input.name,
      templateRef: input.templateRef,
      templateName: input.templateName ?? template.friendlyName,
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
