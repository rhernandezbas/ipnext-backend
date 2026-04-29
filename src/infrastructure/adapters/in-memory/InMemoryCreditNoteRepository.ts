import { CreditNote } from '@domain/entities/billing';
import { CreditNoteRepository } from '@domain/ports/CreditNoteRepository';

let nextId = 7;

export class InMemoryCreditNoteRepository implements CreditNoteRepository {
  private notes: CreditNote[] = [
    {
      id: '1',
      number: 'NC-2024-001',
      clientId: 'cli-001',
      clientName: 'Juan Pérez',
      amount: 5000,
      taxAmount: 1050,
      totalAmount: 6050,
      reason: 'Error en facturación',
      relatedInvoiceId: 'inv-001',
      status: 'applied',
      issuedAt: '2024-01-15',
      appliedAt: '2024-01-20',
      notes: 'Crédito aplicado correctamente',
    },
    {
      id: '2',
      number: 'NC-2024-002',
      clientId: 'cli-002',
      clientName: 'María González',
      amount: 2500,
      taxAmount: 525,
      totalAmount: 3025,
      reason: 'Descuento por fidelidad',
      relatedInvoiceId: null,
      status: 'sent',
      issuedAt: '2024-02-01',
      appliedAt: null,
      notes: 'Cliente VIP',
    },
    {
      id: '3',
      number: 'NC-2024-003',
      clientId: 'cli-003',
      clientName: 'Carlos Rodríguez',
      amount: 1200,
      taxAmount: 252,
      totalAmount: 1452,
      reason: 'Servicio no brindado',
      relatedInvoiceId: 'inv-005',
      status: 'draft',
      issuedAt: '2024-03-10',
      appliedAt: null,
      notes: '',
    },
    {
      id: '4',
      number: 'NC-2024-004',
      clientId: 'cli-004',
      clientName: 'Ana Martínez',
      amount: 800,
      taxAmount: 168,
      totalAmount: 968,
      reason: 'Cobro duplicado',
      relatedInvoiceId: 'inv-010',
      status: 'voided',
      issuedAt: '2024-04-05',
      appliedAt: null,
      notes: 'Anulada por error',
    },
    {
      id: '5',
      number: 'NC-2024-005',
      clientId: 'cli-005',
      clientName: 'Luis Fernández',
      amount: 3500,
      taxAmount: 735,
      totalAmount: 4235,
      reason: 'Ajuste de precio retroactivo',
      relatedInvoiceId: 'inv-015',
      status: 'applied',
      issuedAt: '2024-05-20',
      appliedAt: '2024-05-25',
      notes: 'Ajuste aprobado por gerencia',
    },
    {
      id: '6',
      number: 'NC-2024-006',
      clientId: 'cli-001',
      clientName: 'Juan Pérez',
      amount: 600,
      taxAmount: 126,
      totalAmount: 726,
      reason: 'Interrupción del servicio',
      relatedInvoiceId: null,
      status: 'draft',
      issuedAt: '2024-06-01',
      appliedAt: null,
      notes: 'Pendiente de revisión',
    },
  ];

  async findAll(): Promise<CreditNote[]> {
    return [...this.notes];
  }

  async findById(id: string): Promise<CreditNote | null> {
    return this.notes.find(n => n.id === id) ?? null;
  }

  async create(data: Omit<CreditNote, 'id'>): Promise<CreditNote> {
    const note: CreditNote = { ...data, id: String(nextId++) };
    this.notes.push(note);
    return note;
  }

  async update(id: string, data: Partial<CreditNote>): Promise<CreditNote | null> {
    const index = this.notes.findIndex(n => n.id === id);
    if (index === -1) return null;
    this.notes[index] = { ...this.notes[index], ...data };
    return this.notes[index];
  }
}
