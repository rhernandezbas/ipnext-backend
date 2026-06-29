/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NOTE: Uses `as any` on Prisma calls because the Prisma client is generated
 * from the DB — new models appear after running `prisma generate` post-migration.
 * The casts are safe: the schema and columns are correct.
 */
import { RecaptureLead, RecaptureContact, RecaptureLeadStatus } from '@domain/entities/recaptureLead';
import {
  RecaptureRepository,
  ListRecaptureLeadsQuery,
  CreateRecaptureLeadData,
  AddContactData,
  RecaptureLeadWithContacts,
} from '@domain/ports/RecaptureRepository';
import { PaginatedResult } from '@application/dto/pagination';
import { prisma } from '../../database/prisma';

// ─── Row mappers ─────────────────────────────────────────────────────────────

function toRecaptureLeadDomain(row: any): RecaptureLead {
  return {
    id: row.id,
    source: row.source,
    clientId: row.clientId ?? null,
    contactName: row.contactName,
    phone: row.phone ?? null,
    email: row.email ?? null,
    status: row.status,
    assigneeId: row.assigneeId ?? null,
    // Resolved when include: { assignee: { select: { id, name } } } is used.
    // Falls back to null for raw rows (e.g. $queryRaw RETURNING *).
    assigneeName: row.assignee?.name ?? null,
    claimedAt: row.claimedAt instanceof Date ? row.claimedAt.toISOString() : (row.claimedAt ?? null),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
    address: row.address ?? null,
    churnReason: row.churnReason ?? null,
    previousPlan: row.previousPlan ?? null,
  };
}

function toRecaptureContactDomain(row: any): RecaptureContact {
  return {
    id: row.id,
    leadId: row.leadId,
    actorId: row.actorId,
    channel: row.channel,
    outcome: row.outcome,
    proposal: row.proposal ?? null,
    note: row.note ?? null,
    nextStepAt: row.nextStepAt instanceof Date ? row.nextStepAt.toISOString() : (row.nextStepAt ?? null),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

// ─── Repository ──────────────────────────────────────────────────────────────

export class PrismaRecaptureRepository implements RecaptureRepository {
  async list(query: ListRecaptureLeadsQuery): Promise<PaginatedResult<RecaptureLead>> {
    const where: Record<string, unknown> = {};
    if (query.source) where['source'] = query.source;
    if (query.status) where['status'] = query.status;
    if (query.unassigned) {
      where['assigneeId'] = null;
    } else if (query.assigneeId) {
      where['assigneeId'] = query.assigneeId;
    }
    // technology filter is applied upstream (ListRecaptureLeads → clientIds): WHERE clientId IN (...)
    if (query.clientIds) {
      where['clientId'] = { in: query.clientIds };
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const skip = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      (prisma as any).recaptureLead.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'asc' },
        include: { assignee: { select: { id: true, name: true } } },
      }),
      (prisma as any).recaptureLead.count({ where }),
    ]);

    return {
      data: rows.map(toRecaptureLeadDomain),
      total,
      page,
      limit,
    };
  }

  async getById(id: string): Promise<RecaptureLeadWithContacts | null> {
    const row = await (prisma as any).recaptureLead.findUnique({
      where: { id },
      include: {
        assignee: { select: { id: true, name: true } },
        contacts: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!row) return null;

    return {
      ...toRecaptureLeadDomain(row),
      contacts: (row.contacts as any[]).map(toRecaptureContactDomain),
    };
  }

  async create(data: CreateRecaptureLeadData): Promise<RecaptureLead> {
    const row = await (prisma as any).recaptureLead.create({
      data: {
        source: data.source,
        clientId: data.clientId ?? null,
        contactName: data.contactName,
        phone: data.phone ?? null,
        email: data.email ?? null,
        address: data.address ?? null,
        churnReason: data.churnReason ?? null,
        previousPlan: data.previousPlan ?? null,
      },
    });
    return toRecaptureLeadDomain(row);
  }

  /**
   * Atomic claim via updateMany with assigneeId IS NULL guard.
   * Returns updated lead or null if already claimed (count === 0).
   */
  async claim(leadId: string, actorId: string): Promise<RecaptureLead | null> {
    const result = await (prisma as any).recaptureLead.updateMany({
      where: { id: leadId, assigneeId: null },
      data: {
        assigneeId: actorId,
        claimedAt: new Date(),
        status: 'en_gestion',
      },
    });
    if (result.count === 0) return null;

    const row = await (prisma as any).recaptureLead.findUnique({
      where: { id: leadId },
      include: { assignee: { select: { id: true, name: true } } },
    });
    return row ? toRecaptureLeadDomain(row) : null;
  }

  async updateStatus(leadId: string, status: RecaptureLeadStatus): Promise<RecaptureLead | null> {
    const result = await (prisma as any).recaptureLead.updateMany({
      where: { id: leadId },
      data: { status },
    });
    if (result.count === 0) return null;

    const row = await (prisma as any).recaptureLead.findUnique({
      where: { id: leadId },
      include: { assignee: { select: { id: true, name: true } } },
    });
    return row ? toRecaptureLeadDomain(row) : null;
  }

  async addContact(data: AddContactData): Promise<RecaptureContact> {
    // Use a transaction to atomically create the contact and optionally update the lead status
    const contact = await (prisma as any).$transaction(async (tx: any) => {
      const created = await tx.recaptureContact.create({
        data: {
          leadId: data.leadId,
          actorId: data.actorId,
          channel: data.channel,
          outcome: data.outcome,
          proposal: data.proposal ?? null,
          note: data.note ?? null,
          nextStepAt: data.nextStepAt ? new Date(data.nextStepAt) : null,
        },
      });

      if (data.advanceStatus) {
        await tx.recaptureLead.update({
          where: { id: data.leadId },
          data: { status: data.advanceStatus },
        });
      }

      return created;
    });

    return toRecaptureContactDomain(contact);
  }

  /**
   * Unconditional assign — no assigneeId IS NULL guard.
   * operatorId non-null: set assigneeId, claimedAt=now, status='en_gestion'.
   * operatorId null:     clear assigneeId, claimedAt; reset status='nuevo'.
   */
  async assign(leadId: string, operatorId: string | null): Promise<RecaptureLead | null> {
    const data: Record<string, unknown> = operatorId !== null
      ? { assigneeId: operatorId, claimedAt: new Date(), status: 'en_gestion' }
      : { assigneeId: null, claimedAt: null, status: 'nuevo' };

    const result = await (prisma as any).recaptureLead.updateMany({
      where: { id: leadId },
      data,
    });
    if (result.count === 0) return null;

    const row = await (prisma as any).recaptureLead.findUnique({
      where: { id: leadId },
      include: { assignee: { select: { id: true, name: true } } },
    });
    return row ? toRecaptureLeadDomain(row) : null;
  }

  async ingestChurned(
    clients: Array<{ id: string; name: string; phone?: string | null; email?: string | null }>,
  ): Promise<number> {
    let created = 0;

    for (const client of clients) {
      try {
        // ON CONFLICT (partial unique index) => skip
        await (prisma as any).recaptureLead.create({
          data: {
            source: 'churned_client',
            clientId: client.id,
            contactName: client.name,
            phone: client.phone ?? null,
            email: client.email ?? null,
          },
        });
        created++;
      } catch (err: any) {
        // P2002 = unique constraint violation — already exists, skip
        if (err?.code === 'P2002') continue;
        throw err;
      }
    }

    return created;
  }
}
