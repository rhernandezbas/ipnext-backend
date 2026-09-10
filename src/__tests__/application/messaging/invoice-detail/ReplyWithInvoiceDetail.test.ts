/**
 * whatsapp-invoice-detail-quickreply (Phase 5, QR-1..QR-4) — orchestrator.
 * Zero mocks de axios/Prisma: reader in-memory (3.4) + `FakeChatwootGateway`
 * (helper compartido, NO assistant-specific) + fakes mínimos de
 * `CustomerRepository`/`CampaignSegmentSource`/`RefreshClientBalanceIfStale`
 * (mismo molde que `ClienteFacturasResolver.test.ts`, sin importar de
 * `assistant/*` — QR-2).
 */
import { ReplyWithInvoiceDetail } from '@application/use-cases/messaging/invoice-detail/ReplyWithInvoiceDetail';
import {
  GR_LOOKUP_FAILED_MESSAGE,
  NO_PENDING_INVOICES_MESSAGE,
  MAX_INVOICES_IN_REPLY,
  MAX_REPLY_LENGTH,
} from '@application/use-cases/messaging/invoice-detail/renderInvoiceDetailReply';
import { INVOICE_DETAIL_BUTTON_TITLE } from '@application/use-cases/messaging/invoice-detail/invoiceDetailButton';
import { InMemoryInvoiceDetailReader } from '@infrastructure/adapters/in-memory/InMemoryInvoiceDetailReader';
import { FakeChatwootGateway } from '../../../helpers/FakeChatwootGateway';
import type { Customer } from '@domain/entities/customer';
import type { CustomerRepository, CampaignSegmentSource, CampaignRecipientCandidate } from '@domain/ports/CustomerRepository';
import type { RefreshClientBalanceIfStale } from '@application/use-cases/RefreshClientBalanceIfStale';

const CLIENT_PHONE = '+5493364111111'; // ya E164, matchea directo con toWhatsAppE164

/** Repo que devuelve el customer ACTUAL — mismo molde que `ClienteFacturasResolver.test.ts`:
 * el orchestrator re-lee tras un refresh exitoso, así que el double debe poder reflejarlo. */
function customerRepoOf(get: () => Customer): CustomerRepository {
  return { findById: async () => get() } as unknown as CustomerRepository;
}

function segmentSourceOf(candidates: CampaignRecipientCandidate[]): CampaignSegmentSource {
  return { listSegmentRecipients: async () => candidates };
}

function refreshDouble(ok: boolean, onOk?: () => void): { refresh: RefreshClientBalanceIfStale; calls: number[] } {
  const calls: number[] = [];
  const refresh = {
    execute: async () => {
      calls.push(1);
      if (ok) onOk?.();
      return ok;
    },
  } as unknown as RefreshClientBalanceIfStale;
  return { refresh, calls };
}

function freshCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'client-1',
    grClienteId: 'GR1',
    name: 'Juan Pérez',
    email: 'juan@example.com',
    phone: CLIENT_PHONE,
    status: 'active',
    address: '',
    city: '',
    country: 'AR',
    login: 'juan',
    createdAt: '2026-01-01T00:00:00.000Z',
    balanceDue: 0,
    balanceCurrency: null,
    lastBalanceAt: new Date().toISOString(),
    balanceStale: false,
    ...overrides,
  } as Customer;
}

const CANDIDATE: CampaignRecipientCandidate = {
  clientId: 'client-1',
  name: 'Juan Pérez',
  phone: CLIENT_PHONE,
  balanceDue: 0,
  whatsappOptOutAt: null,
};

describe('ReplyWithInvoiceDetail (Phase 5)', () => {
  it('trigger + factura pendiente + cliente resuelto (no stale) → UN sendMessage con el detalle', async () => {
    const reader = new InMemoryInvoiceDetailReader({
      invoicesByClientId: {
        'client-1': [
          {
            tipo: 'Factura',
            numero: '0001-1',
            vencimiento: '2026-09-10T00:00:00.000Z',
            saldo: 1000,
            pdfUrl: 'https://gr.example/pdf/1',
            paymentUrl: 'https://mp.example/pay/1',
          },
        ],
      },
    });
    const chatwoot = new FakeChatwootGateway();
    const { refresh, calls } = refreshDouble(true);
    const uc = new ReplyWithInvoiceDetail(
      customerRepoOf(() => freshCustomer()),
      segmentSourceOf([CANDIDATE]),
      reader,
      chatwoot,
      refresh,
    );

    await uc.execute({ content: INVOICE_DETAIL_BUTTON_TITLE, phone: CLIENT_PHONE, chatwootConversationId: 42 });

    expect(chatwoot.sendMessageCalls).toHaveLength(1);
    expect(chatwoot.sendMessageCalls[0].chatwootConversationId).toBe(42);
    expect(chatwoot.sendMessageCalls[0].content).toContain('0001-1');
    // Cliente NO stale ⇒ el refresh no debería ni intentarse.
    expect(calls).toHaveLength(0);
  });

  it('contenido no relacionado (no es el título del botón) → NO envía nada', async () => {
    const reader = new InMemoryInvoiceDetailReader();
    const chatwoot = new FakeChatwootGateway();
    const { refresh } = refreshDouble(true);
    const uc = new ReplyWithInvoiceDetail(customerRepoOf(() => freshCustomer()), segmentSourceOf([CANDIDATE]), reader, chatwoot, refresh);

    await uc.execute({ content: 'hola, ¿cómo va?', phone: CLIENT_PHONE, chatwootConversationId: 42 });

    expect(chatwoot.sendMessageCalls).toHaveLength(0);
  });

  it('teléfono sin match en ningún Client → NO envía nada, no lanza (QR-4)', async () => {
    const reader = new InMemoryInvoiceDetailReader();
    const chatwoot = new FakeChatwootGateway();
    const { refresh } = refreshDouble(true);
    // Ningún candidato matchea el teléfono entrante.
    const uc = new ReplyWithInvoiceDetail(
      customerRepoOf(() => freshCustomer()),
      segmentSourceOf([{ ...CANDIDATE, phone: '+5493364999999' }]),
      reader,
      chatwoot,
      refresh,
    );

    await uc.execute({ content: INVOICE_DETAIL_BUTTON_TITLE, phone: CLIENT_PHONE, chatwootConversationId: 42 });

    expect(chatwoot.sendMessageCalls).toHaveLength(0);
  });

  it('el reader de facturas lanza → envía el fallback GR-lookup-failed EXACTO, no relanza (QR-4)', async () => {
    const reader = new InMemoryInvoiceDetailReader({ failForClientId: 'client-1' });
    const chatwoot = new FakeChatwootGateway();
    const { refresh } = refreshDouble(true);
    const uc = new ReplyWithInvoiceDetail(customerRepoOf(() => freshCustomer()), segmentSourceOf([CANDIDATE]), reader, chatwoot, refresh);

    await expect(
      uc.execute({ content: INVOICE_DETAIL_BUTTON_TITLE, phone: CLIENT_PHONE, chatwootConversationId: 42 }),
    ).resolves.toBeUndefined();

    expect(chatwoot.sendMessageCalls).toHaveLength(1);
    expect(chatwoot.sendMessageCalls[0].content).toBe(GR_LOOKUP_FAILED_MESSAGE);
  });

  it('cliente con balance stale y refresh exitoso → intenta el refresh y SIGUE con la lectura real', async () => {
    const reader = new InMemoryInvoiceDetailReader({ invoicesByClientId: { 'client-1': [] } });
    const chatwoot = new FakeChatwootGateway();
    let stale = true; // el repo double refleja el estado DESPUÉS de un refresh exitoso
    const { refresh, calls } = refreshDouble(true, () => {
      stale = false;
    });
    const uc = new ReplyWithInvoiceDetail(
      customerRepoOf(() => freshCustomer({ balanceStale: stale })),
      segmentSourceOf([CANDIDATE]),
      reader,
      chatwoot,
      refresh,
    );

    await uc.execute({ content: INVOICE_DETAIL_BUTTON_TITLE, phone: CLIENT_PHONE, chatwootConversationId: 42 });

    expect(calls).toHaveLength(1); // el refresh SÍ se intenta cuando stale
    expect(chatwoot.sendMessageCalls[0].content).toBe(NO_PENDING_INVOICES_MESSAGE); // cero facturas tras refrescar
  });

  // ── fix wave (review adversarial) — BUG 1: teléfono AMBIGUO ────────────────
  it('el MISMO teléfono resuelve a 2 clientes → NO cita datos de ninguno, manda el fallback', async () => {
    const reader = new InMemoryInvoiceDetailReader({
      invoicesByClientId: {
        'client-1': [{ tipo: 'Factura', numero: 'AAA-111', vencimiento: '2026-09-10T00:00:00.000Z', saldo: 1000, pdfUrl: null, paymentUrl: null }],
        'client-2': [{ tipo: 'Factura', numero: 'BBB-222', vencimiento: '2026-09-10T00:00:00.000Z', saldo: 2000, pdfUrl: null, paymentUrl: null }],
      },
    });
    const chatwoot = new FakeChatwootGateway();
    const { refresh } = refreshDouble(true);
    const uc = new ReplyWithInvoiceDetail(
      customerRepoOf(() => freshCustomer()),
      // Co-titulares: dos Client distintos con el MISMO teléfono normalizado.
      segmentSourceOf([CANDIDATE, { ...CANDIDATE, clientId: 'client-2', name: 'María Pérez' }]),
      reader,
      chatwoot,
      refresh,
    );

    await uc.execute({ content: INVOICE_DETAIL_BUTTON_TITLE, phone: CLIENT_PHONE, chatwootConversationId: 42 });

    expect(chatwoot.sendMessageCalls).toHaveLength(1);
    expect(chatwoot.sendMessageCalls[0].content).toBe(GR_LOOKUP_FAILED_MESSAGE);
    expect(chatwoot.sendMessageCalls[0].content).not.toContain('AAA-111');
    expect(chatwoot.sendMessageCalls[0].content).not.toContain('BBB-222');
  });

  // ── fix wave (review adversarial) — BUG 3: muchas facturas, un solo envío ──
  it('cliente con MUCHAS facturas pendientes → un mensaje acotado que SÍ se envía', async () => {
    const invoices = Array.from({ length: MAX_INVOICES_IN_REPLY + 10 }, (_, i) => ({
      tipo: 'Factura',
      numero: `0001-${i + 1}`,
      vencimiento: '2026-09-10T00:00:00.000Z',
      saldo: 41410.56,
      pdfUrl: 'https://gr.example/pdf/0001-000123456',
      paymentUrl: 'https://mp.example/pay/0001-000123456',
    }));
    const reader = new InMemoryInvoiceDetailReader({ invoicesByClientId: { 'client-1': invoices } });
    const chatwoot = new FakeChatwootGateway();
    const { refresh } = refreshDouble(true);
    const uc = new ReplyWithInvoiceDetail(customerRepoOf(() => freshCustomer()), segmentSourceOf([CANDIDATE]), reader, chatwoot, refresh);

    await uc.execute({ content: INVOICE_DETAIL_BUTTON_TITLE, phone: CLIENT_PHONE, chatwootConversationId: 42 });

    expect(chatwoot.sendMessageCalls).toHaveLength(1);
    expect(chatwoot.sendMessageCalls[0].content.length).toBeLessThanOrEqual(MAX_REPLY_LENGTH);
    expect(chatwoot.sendMessageCalls[0].content).toContain('0001-1');
  });

  // ── fix wave (review adversarial) — BUG 4: fail-open completo ──────────────
  it('la resolución de teléfono LANZA → igual manda el fallback (no se queda mudo)', async () => {
    const reader = new InMemoryInvoiceDetailReader();
    const chatwoot = new FakeChatwootGateway();
    const { refresh } = refreshDouble(true);
    const explodingSource: CampaignSegmentSource = {
      listSegmentRecipients: async () => {
        throw new Error('DB caída al listar candidatos');
      },
    };
    const uc = new ReplyWithInvoiceDetail(customerRepoOf(() => freshCustomer()), explodingSource, reader, chatwoot, refresh);

    await expect(
      uc.execute({ content: INVOICE_DETAIL_BUTTON_TITLE, phone: CLIENT_PHONE, chatwootConversationId: 42 }),
    ).resolves.toBeUndefined();

    expect(chatwoot.sendMessageCalls).toHaveLength(1);
    expect(chatwoot.sendMessageCalls[0].content).toBe(GR_LOOKUP_FAILED_MESSAGE);
  });

  it('el sendMessage del camino EXITOSO lanza → no propaga, no reintenta (fail-open, se loguea)', async () => {
    const reader = new InMemoryInvoiceDetailReader({
      invoicesByClientId: {
        'client-1': [{ tipo: 'Factura', numero: '0001-1', vencimiento: '2026-09-10T00:00:00.000Z', saldo: 1000, pdfUrl: null, paymentUrl: null }],
      },
    });
    const chatwoot = new FakeChatwootGateway();
    chatwoot.failSendMessage = true;
    const { refresh } = refreshDouble(true);
    const uc = new ReplyWithInvoiceDetail(customerRepoOf(() => freshCustomer()), segmentSourceOf([CANDIDATE]), reader, chatwoot, refresh);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(
        uc.execute({ content: INVOICE_DETAIL_BUTTON_TITLE, phone: CLIENT_PHONE, chatwootConversationId: 42 }),
      ).resolves.toBeUndefined();

      // UN solo intento: nada de reintentar, ni de mandar el fallback encima del fallo de envío.
      expect(chatwoot.sendMessageCalls).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('cliente sigue stale tras el intento de refresh → fallback GR-lookup-failed (nunca cita datos viejos)', async () => {
    const reader = new InMemoryInvoiceDetailReader({
      invoicesByClientId: { 'client-1': [{ tipo: 'Factura', numero: 'x', vencimiento: '', saldo: 1, pdfUrl: null, paymentUrl: null }] },
    });
    const chatwoot = new FakeChatwootGateway();
    const { refresh } = refreshDouble(false); // el refresh no logra corregir el stale
    const uc = new ReplyWithInvoiceDetail(
      customerRepoOf(() => freshCustomer({ balanceStale: true })),
      segmentSourceOf([CANDIDATE]),
      reader,
      chatwoot,
      refresh,
    );

    await uc.execute({ content: INVOICE_DETAIL_BUTTON_TITLE, phone: CLIENT_PHONE, chatwootConversationId: 42 });

    expect(chatwoot.sendMessageCalls[0].content).toBe(GR_LOOKUP_FAILED_MESSAGE);
  });
});
