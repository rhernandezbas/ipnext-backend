import { ConversationLabel } from '@domain/entities/conversation-label';
import { ConversationLabelRepository } from '@domain/ports/ConversationLabelRepository';
import { prisma } from '../../database/prisma';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toConversationLabel(row: any): ConversationLabel {
  return { id: row.id, name: row.name, color: row.color };
}

/**
 * conversation-labels (Ola 5) — Prisma adapter del catálogo de etiquetas. Clon de
 * `PrismaTicketAreaCatalogRepository`. Verificado por el port in-memory en los tests
 * de use-case; este adapter se ejercita en integración.
 */
export class PrismaConversationLabelRepository implements ConversationLabelRepository {
  async list(): Promise<ConversationLabel[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).conversationLabel.findMany({ orderBy: { name: 'asc' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map(toConversationLabel);
  }

  async getById(id: string): Promise<ConversationLabel | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).conversationLabel.findUnique({ where: { id } });
    return row ? toConversationLabel(row) : null;
  }

  async getByName(name: string): Promise<ConversationLabel | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).conversationLabel.findMany();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = rows.find((r: any) => r.name.toLowerCase() === name.toLowerCase());
    return row ? toConversationLabel(row) : null;
  }

  async findByIds(ids: string[]): Promise<ConversationLabel[]> {
    if (ids.length === 0) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).conversationLabel.findMany({ where: { id: { in: ids } } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map(toConversationLabel);
  }

  async create(data: { name: string; color: string }): Promise<ConversationLabel> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).conversationLabel.create({ data });
    return toConversationLabel(row);
  }

  async update(id: string, data: Partial<{ name: string; color: string }>): Promise<ConversationLabel | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = await (prisma as any).conversationLabel.update({ where: { id }, data });
      return toConversationLabel(row);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (prisma as any).conversationLabel.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }
}
