import { CreditNote } from '@domain/entities/billing';
import { CreditNoteRepository } from '@domain/ports/CreditNoteRepository';
import { prisma } from '../../database/prisma';

function toCreditNote(row: any): CreditNote {
  return {
    id: row.id,
    number: row.number,
    clientId: row.clientId,
    clientName: row.clientName,
    amount: row.amount,
    taxAmount: row.taxAmount,
    totalAmount: row.totalAmount,
    reason: row.reason,
    relatedInvoiceId: row.relatedInvoiceId ?? null,
    status: row.status,
    issuedAt: row.issuedAt instanceof Date ? row.issuedAt.toISOString().split('T')[0] : row.issuedAt,
    appliedAt: row.appliedAt
      ? (row.appliedAt instanceof Date ? row.appliedAt.toISOString().split('T')[0] : row.appliedAt)
      : null,
    notes: row.notes ?? '',
  };
}

export class InMemoryCreditNoteRepository implements CreditNoteRepository {
  async findAll(): Promise<CreditNote[]> {
    const rows = await prisma.creditNote.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map(toCreditNote);
  }

  async findById(id: string): Promise<CreditNote | null> {
    const row = await prisma.creditNote.findUnique({ where: { id } });
    return row ? toCreditNote(row) : null;
  }

  async create(data: Omit<CreditNote, 'id'>): Promise<CreditNote> {
    const row = await prisma.creditNote.create({
      data: {
        number: data.number,
        clientId: data.clientId,
        clientName: data.clientName,
        amount: data.amount,
        taxAmount: data.taxAmount,
        totalAmount: data.totalAmount,
        reason: data.reason,
        relatedInvoiceId: data.relatedInvoiceId ?? null,
        status: data.status,
        notes: data.notes ?? null,
        issuedAt: data.issuedAt ? new Date(data.issuedAt) : new Date(),
        appliedAt: data.appliedAt ? new Date(data.appliedAt) : null,
      },
    });
    return toCreditNote(row);
  }

  async update(id: string, data: Partial<CreditNote>): Promise<CreditNote | null> {
    try {
      const row = await prisma.creditNote.update({
        where: { id },
        data: {
          ...(data.status !== undefined && { status: data.status }),
          ...(data.notes !== undefined && { notes: data.notes }),
          ...(data.appliedAt !== undefined && {
            appliedAt: data.appliedAt ? new Date(data.appliedAt) : null,
          }),
          ...(data.relatedInvoiceId !== undefined && { relatedInvoiceId: data.relatedInvoiceId }),
        },
      });
      return toCreditNote(row);
    } catch {
      return null;
    }
  }
}
