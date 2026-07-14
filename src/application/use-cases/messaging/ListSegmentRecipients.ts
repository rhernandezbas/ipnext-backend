import type { CampaignSegmentSource } from '@domain/ports/CustomerRepository';
import type { ListSegmentRecipientsInput, ListSegmentRecipientsOutput } from '@application/dto/messaging-bulk.dto';
import { resolveRecipients } from './resolveRecipients';
import { assertSegmentIsFiltered } from './assertSegmentIsFiltered';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 25;

/**
 * messaging-bulk v1.1 (preview modal paginado) — a.k.a. el "ver todos" del
 * preview. Molde `PreviewCampaignSegment`: MISMA resolución (delega en
 * `CampaignSegmentSource.listSegmentRecipients` + `resolveRecipients` para
 * opt-out/dedup/teléfono-inválido/statusCounts), pero en vez de recortar a
 * `SAMPLE_SIZE` devuelve el set `resolved` COMPLETO paginado.
 *
 * El segmento NO está persistido — no hay tabla de "destinatarios de esta
 * campaña" para paginar del lado de la DB (la campaña recién se materializa
 * en `CreateCampaign`). Por eso CADA llamada re-resuelve
 * `listSegmentRecipients` (el universo completo del segmento) y pagina el
 * array YA resuelto en memoria — mismo tradeoff recall-over-pagination que
 * `listSegmentRecipients`/`listActiveContacts` ya documentan (design §4.2):
 * el universo de un segmento de bulk no es un `Client.findMany` paginado de
 * millones de filas, es la base de clientes activa/deudora/etc.
 *
 * De solo lectura por construcción (SEG-5, mismo criterio que
 * `PreviewCampaignSegment`): no recibe ningún `CampaignRepository`.
 *
 * Gate RBAC `messaging.bulk` se aplica en la ruta, no acá.
 */
export class ListSegmentRecipients {
  constructor(private readonly segmentSource: CampaignSegmentSource) {}

  async execute(input: ListSegmentRecipientsInput): Promise<ListSegmentRecipientsOutput> {
    // Mismo guard que PreviewCampaignSegment/CreateCampaign — rechaza ANTES de
    // tocar la fuente un segmento sin criterio real (apuntaría a toda la base).
    assertSegmentIsFiltered(input);

    const candidates = await this.segmentSource.listSegmentRecipients({
      statuses: input.statuses,
      balanceMin: input.balanceMin,
      balanceMax: input.balanceMax,
    });

    const { resolved, excludedOptOut, excludedNoPhone, dedupCollapsed, statusCounts } = resolveRecipients(candidates);

    const page = input.page && input.page > 0 ? input.page : DEFAULT_PAGE;
    const limit = input.limit && input.limit > 0 ? input.limit : DEFAULT_LIMIT;
    const start = (page - 1) * limit;
    const pageItems = resolved.slice(start, start + limit);

    return {
      data: pageItems.map((r) => ({
        clientId: r.clientId,
        name: r.name,
        phoneE164: r.phoneE164,
        status: r.status,
      })),
      total: resolved.length,
      page,
      limit,
      skipped: {
        optedOut: excludedOptOut,
        duplicatePhone: dedupCollapsed,
        invalidPhone: excludedNoPhone,
      },
      statusCounts,
    };
  }
}
