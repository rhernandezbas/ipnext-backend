import type { CampaignSegmentSource, ManualRecipientSource } from '@domain/ports/CustomerRepository';
import type { TaskRecipientSource } from '@domain/ports/TaskRecipientSource';
import type { TaskStageRecipientConfigRepository } from '@domain/ports/TaskStageRecipientConfigRepository';
import type { ListSegmentRecipientsInput, ListSegmentRecipientsOutput } from '@application/dto/messaging-bulk.dto';
import { assertHasRecipients } from './assertHasRecipients';
import { assertTaskStagesEligible } from './assertTaskStagesEligible';
import { resolveCombinedRecipients, normalizeManualClientIds, normalizeManualContacts } from './resolveCombinedRecipients';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 25;

/**
 * messaging-bulk v1.1 (preview modal paginado) + bulk-csv-recipients (D11,
 * DET-1..DET-3) — a.k.a. el "ver todos" del preview, EXTENDIDO a la UNIÓN
 * completa (segmento ∪ manualClientIds ∪ manualContacts, cierra la deuda F4
 * documentada en el FE) + una 2da vista (`view:'excluded'`) con el detalle
 * paginado de CADA exclusión (D7).
 *
 * El segmento NO está persistido — no hay tabla de "destinatarios de esta
 * campaña" para paginar del lado de la DB (la campaña recién se materializa en
 * `CreateCampaign`). Por eso CADA llamada re-resuelve la unión completa (mismo
 * tradeoff recall-over-pagination ya documentado, design §4.2) y pagina el
 * array YA resuelto en memoria — el WIRE está SIEMPRE acotado por `limit`
 * (nunca fetch-all en la respuesta), en AMBAS vistas.
 *
 * De solo lectura por construcción (SEG-5, mismo criterio que
 * `PreviewCampaignSegment`): no recibe ningún `CampaignRepository`.
 *
 * Gate RBAC `messaging.bulk` se aplica en la ruta, no acá.
 */
export class ListSegmentRecipients {
  constructor(
    private readonly segmentSource: CampaignSegmentSource,
    // bulk-csv-recipients (DET-1) — OPCIONAL: molde `PreviewCampaignSegment` (MAN-5),
    // requerido solo cuando el input trae `manualClientIds`. El wiring real
    // (app.ts) SIEMPRE lo inyecta (misma instancia `customerAdapter`).
    private readonly manualRecipientSource?: ManualRecipientSource,
    // bulk-task-recipients (D3, D5) — 2 args OPCIONALES nuevos AL FINAL (molde
    // `PreviewCampaignSegment`).
    private readonly taskRecipientSource?: TaskRecipientSource,
    private readonly taskStageConfigRepo?: TaskStageRecipientConfigRepository,
  ) {}

  async execute(input: ListSegmentRecipientsInput): Promise<ListSegmentRecipientsOutput> {
    const manualClientIds = normalizeManualClientIds(input.manualClientIds);
    const manualContacts = normalizeManualContacts(input.manualContacts);
    // bulk-task-recipients (TASK-1) — 5to dominio, PARALELO.
    const taskStageIds = input.taskStageIds ?? [];

    // bulk-csv-recipients (DET-1) — el guard pasa de `assertSegmentIsFiltered`
    // (segment-only) a `assertHasRecipients`: un preview solo-manual, solo-CSV o
    // solo-tarea deja de ser 400 (cierra la deuda F4 documentada en el propio FE).
    assertHasRecipients(input, manualClientIds, manualContacts, taskStageIds);
    // bulk-task-recipients (TASK-2, D3) — elegibilidad ANTES de resolver clientes.
    await assertTaskStagesEligible(taskStageIds, this.taskStageConfigRepo);

    const { resolved, excludedDetail, segmentSkipped, manualSkipped, csvSkipped, taskSkipped, statusCounts, noCustomerCount } =
      await resolveCombinedRecipients({
        segment: input,
        manualClientIds,
        manualContacts,
        taskStageIds,
        segmentSource: this.segmentSource,
        manualRecipientSource: this.manualRecipientSource,
        taskRecipientSource: this.taskRecipientSource,
      });

    const page = input.page && input.page > 0 ? input.page : DEFAULT_PAGE;
    const limit = input.limit && input.limit > 0 ? input.limit : DEFAULT_LIMIT;
    const start = (page - 1) * limit;

    // bulk-csv-recipients (D11) — `view:'excluded'` (default `'recipients'`,
    // backcompat exacto): UNA sola resolución (`resolveCombinedRecipients` de
    // arriba), el `view` solo decide QUÉ array se pagina hacia el wire.
    const view = input.view ?? 'recipients';
    let data: ListSegmentRecipientsOutput['data'];
    let total: number;
    if (view === 'excluded') {
      data = excludedDetail.slice(start, start + limit).map((e) => ({
        name: e.name,
        phone: e.phone,
        reason: e.reason,
        source: e.source,
        ...(e.clientId !== undefined ? { clientId: e.clientId } : {}),
        ...(e.status !== undefined ? { status: e.status } : {}),
      }));
      total = excludedDetail.length;
    } else {
      data = resolved.slice(start, start + limit).map((r) => ({
        clientId: r.clientId,
        name: r.name,
        phoneE164: r.phoneE164,
        status: r.status,
        source: r.source,
      }));
      total = resolved.length;
    }

    return {
      data,
      total,
      page,
      limit,
      skipped: {
        optedOut: segmentSkipped.optedOut + manualSkipped.optedOut + csvSkipped.optedOut + taskSkipped.optedOut,
        duplicatePhone:
          segmentSkipped.duplicatePhone + manualSkipped.duplicatePhone + csvSkipped.duplicatePhone + taskSkipped.duplicatePhone,
        invalidPhone:
          segmentSkipped.invalidPhone + manualSkipped.invalidPhone + csvSkipped.invalidPhone + taskSkipped.invalidPhone,
      },
      statusCounts,
      noCustomerCount,
    };
  }
}
