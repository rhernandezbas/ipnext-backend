import type { CustomerRepository, CampaignSegmentSource } from '@domain/ports/CustomerRepository';
import type { InvoiceDetailReader, InvoiceDetailInvoice } from '@domain/ports/InvoiceDetailReader';
import type { ChatwootGateway } from '@domain/ports/ChatwootGateway';
import type { RefreshClientBalanceIfStale } from '@application/use-cases/RefreshClientBalanceIfStale';
import { toWhatsAppE164 } from '@application/use-cases/messaging/toWhatsAppE164';
import { isInvoiceDetailTrigger } from './invoiceDetailButton';
import { renderInvoiceDetailReply } from './renderInvoiceDetailReply';

export interface ReplyWithInvoiceDetailInput {
  content: string | null | undefined;
  phone: string | null | undefined;
  chatwootConversationId: number;
}

/**
 * whatsapp-invoice-detail-quickreply (Phase 5, design "Data Flow" +
 * "Architecture Decisions") — orchestrator del quick-reply de detalle de
 * facturas. Archivo NUEVO, ZERO imports desde `assistant/*` (QR-2), NUNCA lee
 * `ai-assistant-enabled`.
 *
 * Pipeline exacto del diseño: `isInvoiceDetailTrigger` → `toWhatsAppE164` →
 * `CampaignSegmentSource` → clientId → `RefreshClientBalanceIfStale` (si stale)
 * → `InvoiceDetailReader.listOpenByClientId` → `renderInvoiceDetailReply` →
 * `ChatwootGateway.sendMessage`. `GestionRealClient` se reusa INDIRECTAMENTE, a
 * través de `RefreshClientBalanceIfStale` — este archivo nunca llama a GR
 * directamente (design "do NOT duplicate GR API access").
 *
 * Nunca lanza (QR-4): try/catch alrededor de la resolución de facturas, y un
 * cliente que sigue `balanceStale` tras el intento de refresh se trata como
 * "el lookup falló" (mismo criterio que `ClienteFacturasResolver`: un espejo
 * viejo no es una fuente confiable, y citarlo es peor que disculparse).
 */
export class ReplyWithInvoiceDetail {
  constructor(
    private readonly customers: CustomerRepository,
    private readonly segmentSource: CampaignSegmentSource,
    private readonly reader: InvoiceDetailReader,
    private readonly chatwoot: ChatwootGateway,
    private readonly refreshBalance: RefreshClientBalanceIfStale,
  ) {}

  async execute(input: ReplyWithInvoiceDetailInput): Promise<void> {
    if (!isInvoiceDetailTrigger(input.content ?? '')) return;

    const fromE164 = toWhatsAppE164(input.phone);
    if (fromE164 === null) return; // teléfono no reconstruible → no-op (QR-4)

    // fix wave (review adversarial, BUG 4) — el try envuelve TODO el pipeline
    // resolve→lookup→format: antes la resolución del teléfono quedaba AFUERA, y
    // una caída de la DB al listar candidatos dejaba al cliente sin ninguna
    // respuesta (ni siquiera el fallback).
    let text: string;
    try {
      const resolution = await this.resolveClient(fromE164);
      if (resolution === 'none') return; // QR-4 — sin match, sin reply, sin error
      text =
        resolution === 'ambiguous'
          ? renderInvoiceDetailReply(null)
          : renderInvoiceDetailReply(await this.resolveInvoices(resolution.clientId));
    } catch {
      text = renderInvoiceDetailReply(null);
    }

    // El envío va en su PROPIO try: si lo que falla es el envío mismo, no hay
    // nada que reintentar ni un fallback que mandar (mandarlo sería intentar el
    // mismo canal que acaba de fallar). Se loguea y se sigue — mismo fail-open
    // que `maybeRegisterOptOut`/`maybeReplyWithInvoiceDetail` en el webhook.
    try {
      await this.chatwoot.sendMessage(input.chatwootConversationId, text);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[messaging] invoice-detail: no se pudo enviar la respuesta (fail-open)', {
        chatwootConversationId: input.chatwootConversationId,
        error: err instanceof Error ? err.message : err,
      });
    }
  }

  /**
   * Mismo criterio de matcheo E164 EXACTO que `maybeRegisterOptOut`
   * (`ReceiveChatwootWebhook.ts`, FIX-9-v2): `CampaignSegmentSource` se REUSA,
   * no se duplica. `listSegmentRecipients({statuses:[]})` es el escape hatch
   * narrow — universo completo, sin filtro de status.
   *
   * fix wave (review adversarial, BUG 1) — `filter`, NO `find`. Si el mismo
   * E164 resuelve a VARIOS clientes (co-titulares, familiares, el teléfono del
   * comercio) elegir "el primero" le mandaría a una persona los números de
   * factura, el saldo y el link de pago de OTRA. Mismo guardrail, palabra por
   * palabra, que `CustomerAssistantClientResolver`: ambigüedad ⇒ nadie.
   *
   * `'none'` (cero matches) mantiene el no-op silencioso de QR-4: un teléfono
   * desconocido puede no ser ni cliente, y contestarle es peor que callar.
   * `'ambiguous'` SÍ contesta: el número es de un cliente, así que se le debe
   * una respuesta — la de lookup fallido, sin un solo dato de cuenta.
   */
  private async resolveClient(fromE164: string): Promise<{ clientId: string } | 'none' | 'ambiguous'> {
    const candidates = await this.segmentSource.listSegmentRecipients({ statuses: [] });
    const matches = candidates.filter((c) => {
      const candidateE164 = toWhatsAppE164(c.phone);
      return candidateE164 !== null && candidateE164 === fromE164;
    });
    if (matches.length === 0) return 'none';
    if (matches.length > 1) return 'ambiguous';
    return { clientId: matches[0].clientId };
  }

  /**
   * `null` de retorno ⇒ "tratar como lookup fallido" (QR-4): cubre tanto un
   * error real (reader/GR/DB) como un balance que sigue stale después de
   * intentar refrescarlo — un espejo de facturas tan viejo como un saldo que
   * no confiamos NO es una fuente citable (mismo guardrail que
   * `ClienteFacturasResolver`, D7/D8).
   */
  private async resolveInvoices(clientId: string): Promise<InvoiceDetailInvoice[] | null> {
    try {
      let customer = await this.customers.findById(clientId);

      if (customer.balanceStale && customer.grClienteId) {
        const refreshed = await this.refreshBalance.execute({
          grClienteId: customer.grClienteId,
          lastBalanceAt: customer.lastBalanceAt ?? null,
          status: customer.status,
        });
        if (refreshed) {
          customer = await this.customers.findById(clientId);
        }
      }

      if (customer.balanceStale) return null;

      return await this.reader.listOpenByClientId(clientId);
    } catch {
      return null;
    }
  }
}
