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

    const clientId = await this.resolveClientId(fromE164);
    if (clientId === null) return; // QR-4 — sin match, sin reply, sin error

    const invoices = await this.resolveInvoices(clientId);
    const text = renderInvoiceDetailReply(invoices);
    await this.chatwoot.sendMessage(input.chatwootConversationId, text);
  }

  /**
   * Mismo criterio de matcheo E164 EXACTO que `maybeRegisterOptOut`
   * (`ReceiveChatwootWebhook.ts`, FIX-9-v2): `CampaignSegmentSource` se REUSA,
   * no se duplica. `listSegmentRecipients({statuses:[]})` es el escape hatch
   * narrow — universo completo, sin filtro de status.
   */
  private async resolveClientId(fromE164: string): Promise<string | null> {
    const candidates = await this.segmentSource.listSegmentRecipients({ statuses: [] });
    const match = candidates.find((c) => {
      const candidateE164 = toWhatsAppE164(c.phone);
      return candidateE164 !== null && candidateE164 === fromE164;
    });
    return match?.clientId ?? null;
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
