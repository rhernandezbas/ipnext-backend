import { ProformaInvoice } from '@domain/entities/billing';
import { ProformaRepository } from '@domain/ports/ProformaRepository';

let nextId = 6;

export class InMemoryProformaRepository implements ProformaRepository {
  private proformas: ProformaInvoice[] = [
    {
      id: '1',
      number: 'PRO-2024-001',
      clientId: 'cli-001',
      clientName: 'Juan Pérez',
      items: [
        { description: 'Plan Internet 100 Mbps', quantity: 1, unitPrice: 6500, total: 6500 },
      ],
      subtotal: 6500,
      taxAmount: 1365,
      total: 7865,
      status: 'paid',
      issuedAt: '2024-01-10',
      validUntil: '2024-01-25',
      convertedToInvoiceId: 'inv-001',
      notes: 'Convertida a factura',
    },
    {
      id: '2',
      number: 'PRO-2024-002',
      clientId: 'cli-002',
      clientName: 'María González',
      items: [
        { description: 'Instalación básica', quantity: 1, unitPrice: 3000, total: 3000 },
        { description: 'Router doméstico', quantity: 1, unitPrice: 8500, total: 8500 },
      ],
      subtotal: 11500,
      taxAmount: 2415,
      total: 13915,
      status: 'sent',
      issuedAt: '2024-02-05',
      validUntil: '2024-02-20',
      convertedToInvoiceId: null,
      notes: 'Esperando aprobación del cliente',
    },
    {
      id: '3',
      number: 'PRO-2024-003',
      clientId: 'cli-003',
      clientName: 'Carlos Rodríguez',
      items: [
        { description: 'Plan Internet 300 Mbps', quantity: 1, unitPrice: 12000, total: 12000 },
      ],
      subtotal: 12000,
      taxAmount: 2520,
      total: 14520,
      status: 'draft',
      issuedAt: '2024-03-01',
      validUntil: '2024-03-16',
      convertedToInvoiceId: null,
      notes: '',
    },
    {
      id: '4',
      number: 'PRO-2024-004',
      clientId: 'cli-004',
      clientName: 'Ana Martínez',
      items: [
        { description: 'Plan Internet 25 Mbps', quantity: 1, unitPrice: 3500, total: 3500 },
        { description: 'Soporte técnico mensual', quantity: 1, unitPrice: 1500, total: 1500 },
      ],
      subtotal: 5000,
      taxAmount: 1050,
      total: 6050,
      status: 'expired',
      issuedAt: '2024-01-01',
      validUntil: '2024-01-15',
      convertedToInvoiceId: null,
      notes: 'Expirada sin respuesta',
    },
    {
      id: '5',
      number: 'PRO-2024-005',
      clientId: 'cli-005',
      clientName: 'Luis Fernández',
      items: [
        { description: 'Paquete Internet + VoIP', quantity: 1, unitPrice: 9000, total: 9000 },
      ],
      subtotal: 9000,
      taxAmount: 1890,
      total: 10890,
      status: 'cancelled',
      issuedAt: '2024-04-10',
      validUntil: '2024-04-25',
      convertedToInvoiceId: null,
      notes: 'Cancelada por el cliente',
    },
  ];

  async findAll(): Promise<ProformaInvoice[]> {
    return [...this.proformas];
  }

  async findById(id: string): Promise<ProformaInvoice | null> {
    return this.proformas.find(p => p.id === id) ?? null;
  }

  async create(data: Omit<ProformaInvoice, 'id'>): Promise<ProformaInvoice> {
    const proforma: ProformaInvoice = { ...data, id: String(nextId++) };
    this.proformas.push(proforma);
    return proforma;
  }

  async update(id: string, data: Partial<ProformaInvoice>): Promise<ProformaInvoice | null> {
    const index = this.proformas.findIndex(p => p.id === id);
    if (index === -1) return null;
    this.proformas[index] = { ...this.proformas[index], ...data };
    return this.proformas[index];
  }
}
