import { ProformaInvoice } from '@domain/entities/billing';
import { ProformaRepository } from '@domain/ports/ProformaRepository';
import { prisma } from '../../database/prisma';

function toProforma(row: any): ProformaInvoice {
  return {
    id: row.id,
    number: row.number,
    clientId: row.clientId,
    clientName: row.clientName,
    items: row.items as any,
    subtotal: row.subtotal,
    taxAmount: row.taxAmount,
    total: row.total,
    status: row.status,
    issuedAt: row.issuedAt instanceof Date ? row.issuedAt.toISOString().split('T')[0] : row.issuedAt,
    validUntil: row.validUntil
      ? (row.validUntil instanceof Date ? row.validUntil.toISOString().split('T')[0] : row.validUntil)
      : null,
    convertedToInvoiceId: row.convertedToInvoiceId ?? null,
    notes: row.notes ?? '',
  };
}

export class InMemoryProformaRepository implements ProformaRepository {
  async findAll(): Promise<ProformaInvoice[]> {
    const rows = await prisma.proformaInvoice.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map(toProforma);
  }

  async findById(id: string): Promise<ProformaInvoice | null> {
    const row = await prisma.proformaInvoice.findUnique({ where: { id } });
    return row ? toProforma(row) : null;
  }

  async create(data: Omit<ProformaInvoice, 'id'>): Promise<ProformaInvoice> {
    const row = await prisma.proformaInvoice.create({
      data: {
        number: data.number,
        clientId: data.clientId,
        clientName: data.clientName,
        items: data.items as any,
        subtotal: data.subtotal,
        taxAmount: data.taxAmount,
        total: data.total,
        status: data.status,
        notes: data.notes ?? null,
        issuedAt: data.issuedAt ? new Date(data.issuedAt) : new Date(),
        validUntil: data.validUntil ? new Date(data.validUntil) : null,
        convertedToInvoiceId: data.convertedToInvoiceId ?? null,
      },
    });
    return toProforma(row);
  }

  async update(id: string, data: Partial<ProformaInvoice>): Promise<ProformaInvoice | null> {
    try {
      const row = await prisma.proformaInvoice.update({
        where: { id },
        data: {
          ...(data.status !== undefined && { status: data.status }),
          ...(data.notes !== undefined && { notes: data.notes }),
          ...(data.convertedToInvoiceId !== undefined && {
            convertedToInvoiceId: data.convertedToInvoiceId,
          }),
        },
      });
      return toProforma(row);
    } catch {
      return null;
    }
  }
}
