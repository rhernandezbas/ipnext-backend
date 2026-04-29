import { FinanceHistoryEvent } from '@domain/entities/financeHistory';
import { FinanceHistoryFilter, FinanceHistoryRepository } from '@domain/ports/FinanceHistoryRepository';

export class InMemoryFinanceHistoryRepository implements FinanceHistoryRepository {
  private events: FinanceHistoryEvent[] = [
    {
      id: '1',
      type: 'invoice_created',
      description: 'Factura F-2024-001 creada para Juan Pérez',
      clientId: 'cli-001',
      clientName: 'Juan Pérez',
      amount: 6500,
      referenceId: 'inv-001',
      adminId: 'adm-001',
      adminName: 'Admin Principal',
      occurredAt: '2024-03-29T08:00:00Z',
    },
    {
      id: '2',
      type: 'payment_received',
      description: 'Pago recibido de María González - $7865',
      clientId: 'cli-002',
      clientName: 'María González',
      amount: 7865,
      referenceId: 'pay-001',
      adminId: 'adm-001',
      adminName: 'Admin Principal',
      occurredAt: '2024-03-29T09:30:00Z',
    },
    {
      id: '3',
      type: 'invoice_paid',
      description: 'Factura F-2024-002 marcada como pagada',
      clientId: 'cli-002',
      clientName: 'María González',
      amount: 7865,
      referenceId: 'inv-002',
      adminId: 'adm-002',
      adminName: 'María Soporte',
      occurredAt: '2024-03-29T09:35:00Z',
    },
    {
      id: '4',
      type: 'credit_note_applied',
      description: 'Nota de crédito NC-2024-001 aplicada a Juan Pérez',
      clientId: 'cli-001',
      clientName: 'Juan Pérez',
      amount: 6050,
      referenceId: 'nc-001',
      adminId: 'adm-001',
      adminName: 'Admin Principal',
      occurredAt: '2024-03-30T10:00:00Z',
    },
    {
      id: '5',
      type: 'service_activated',
      description: 'Plan Internet 100 Mbps activado para Carlos Rodríguez',
      clientId: 'cli-003',
      clientName: 'Carlos Rodríguez',
      amount: null,
      referenceId: null,
      adminId: 'adm-002',
      adminName: 'María Soporte',
      occurredAt: '2024-03-31T11:00:00Z',
    },
    {
      id: '6',
      type: 'late_fee',
      description: 'Cargo por mora aplicado a Ana Martínez',
      clientId: 'cli-004',
      clientName: 'Ana Martínez',
      amount: 500,
      referenceId: null,
      adminId: 'adm-001',
      adminName: 'Admin Principal',
      occurredAt: '2024-04-01T08:00:00Z',
    },
    {
      id: '7',
      type: 'invoice_created',
      description: 'Factura F-2024-003 creada para Luis Fernández',
      clientId: 'cli-005',
      clientName: 'Luis Fernández',
      amount: 10890,
      referenceId: 'inv-003',
      adminId: 'adm-001',
      adminName: 'Admin Principal',
      occurredAt: '2024-04-02T09:00:00Z',
    },
    {
      id: '8',
      type: 'refund',
      description: 'Reembolso procesado para Carlos Rodríguez',
      clientId: 'cli-003',
      clientName: 'Carlos Rodríguez',
      amount: 1200,
      referenceId: 'ref-001',
      adminId: 'adm-003',
      adminName: 'Pedro Billing',
      occurredAt: '2024-04-05T14:00:00Z',
    },
    {
      id: '9',
      type: 'plan_changed',
      description: 'Plan cambiado de 25 Mbps a 100 Mbps para Juan Pérez',
      clientId: 'cli-001',
      clientName: 'Juan Pérez',
      amount: null,
      referenceId: null,
      adminId: 'adm-002',
      adminName: 'María Soporte',
      occurredAt: '2024-04-08T10:30:00Z',
    },
    {
      id: '10',
      type: 'payment_received',
      description: 'Pago recibido de Ana Martínez - $6050',
      clientId: 'cli-004',
      clientName: 'Ana Martínez',
      amount: 6050,
      referenceId: 'pay-002',
      adminId: 'adm-001',
      adminName: 'Admin Principal',
      occurredAt: '2024-04-10T11:00:00Z',
    },
    {
      id: '11',
      type: 'service_deactivated',
      description: 'Servicio VoIP desactivado para Luis Fernández por falta de pago',
      clientId: 'cli-005',
      clientName: 'Luis Fernández',
      amount: null,
      referenceId: null,
      adminId: 'adm-001',
      adminName: 'Admin Principal',
      occurredAt: '2024-04-15T08:00:00Z',
    },
    {
      id: '12',
      type: 'invoice_created',
      description: 'Factura F-2024-004 creada para María González',
      clientId: 'cli-002',
      clientName: 'María González',
      amount: 7865,
      referenceId: 'inv-004',
      adminId: 'adm-003',
      adminName: 'Pedro Billing',
      occurredAt: '2024-04-18T09:00:00Z',
    },
    {
      id: '13',
      type: 'credit_note_applied',
      description: 'Nota de crédito NC-2024-005 aplicada a Luis Fernández',
      clientId: 'cli-005',
      clientName: 'Luis Fernández',
      amount: 4235,
      referenceId: 'nc-005',
      adminId: 'adm-001',
      adminName: 'Admin Principal',
      occurredAt: '2024-04-20T10:00:00Z',
    },
    {
      id: '14',
      type: 'invoice_paid',
      description: 'Factura F-2024-003 pagada por Luis Fernández',
      clientId: 'cli-005',
      clientName: 'Luis Fernández',
      amount: 10890,
      referenceId: 'inv-003',
      adminId: 'adm-002',
      adminName: 'María Soporte',
      occurredAt: '2024-04-22T15:00:00Z',
    },
    {
      id: '15',
      type: 'late_fee',
      description: 'Cargo por mora aplicado a Carlos Rodríguez',
      clientId: 'cli-003',
      clientName: 'Carlos Rodríguez',
      amount: 750,
      referenceId: null,
      adminId: 'adm-001',
      adminName: 'Admin Principal',
      occurredAt: '2024-04-28T08:00:00Z',
    },
  ];

  async findAll(filter?: FinanceHistoryFilter): Promise<FinanceHistoryEvent[]> {
    let result = [...this.events];

    if (filter?.clientId) {
      result = result.filter(e => e.clientId === filter.clientId);
    }

    if (filter?.from) {
      const from = new Date(filter.from);
      result = result.filter(e => new Date(e.occurredAt) >= from);
    }

    if (filter?.to) {
      const to = new Date(filter.to);
      result = result.filter(e => new Date(e.occurredAt) <= to);
    }

    return result;
  }
}
