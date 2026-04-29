import { AdminRole_Definition } from '@domain/entities/role';
import { RoleRepository } from '@domain/ports/RoleRepository';
import { prisma } from '../../database/prisma';

function toRole(row: any): AdminRole_Definition {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    isSystem: row.isSystem,
    permissions: row.permissions as any,
  };
}

export class InMemoryRoleRepository implements RoleRepository {
  async findAll(): Promise<AdminRole_Definition[]> {
    const rows = await prisma.adminRoleDefinition.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toRole);
  }

  async findById(id: string): Promise<AdminRole_Definition | null> {
    const row = await prisma.adminRoleDefinition.findUnique({ where: { id } });
    return row ? toRole(row) : null;
  }

  async create(data: Omit<AdminRole_Definition, 'id'>): Promise<AdminRole_Definition> {
    const row = await prisma.adminRoleDefinition.create({
      data: {
        name: data.name,
        description: data.description ?? null,
        isSystem: data.isSystem ?? false,
        permissions: data.permissions as any,
      },
    });
    return toRole(row);
  }

  async update(id: string, data: Partial<AdminRole_Definition>): Promise<AdminRole_Definition | null> {
    try {
      const row = await prisma.adminRoleDefinition.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.isSystem !== undefined && { isSystem: data.isSystem }),
          ...(data.permissions !== undefined && { permissions: data.permissions as any }),
        },
      });
      return toRole(row);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await prisma.adminRoleDefinition.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }
}
