/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NOTE: `as any` on Prisma client calls (consistent with the other RBAC/session
 * adapters) — the Dockerfile runs `prisma generate` in the build.
 */
import { prisma } from '@infrastructure/database/prisma';
import type { PortalAccount } from '@domain/entities/portalAccount';
import type {
  PortalAccountRepository,
  CreatePortalAccountInput,
  UpdatePortalAccountInput,
  PortalAccountClientRef,
} from '@domain/ports/PortalAccountRepository';
import type { PaginatedResult, PaginatedQuery } from '@application/dto/pagination';

type PortalAccountRow = {
  id: string;
  clientId: string;
  dni: string;
  passwordHash: string;
  status: string;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function mapRow(row: PortalAccountRow): PortalAccount {
  return {
    id: row.id,
    clientId: row.clientId,
    dni: row.dni,
    passwordHash: row.passwordHash,
    status: row.status === 'disabled' ? 'disabled' : 'active',
    mustChangePassword: row.mustChangePassword,
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PrismaPortalAccountRepository implements PortalAccountRepository {
  constructor(private readonly db = prisma) {}

  async findById(id: string): Promise<PortalAccount | null> {
    const row = (await (this.db as any).portalAccount.findUnique({ where: { id } })) as PortalAccountRow | null;
    return row ? mapRow(row) : null;
  }

  async findByDni(dni: string): Promise<PortalAccount | null> {
    const row = (await (this.db as any).portalAccount.findUnique({ where: { dni } })) as PortalAccountRow | null;
    return row ? mapRow(row) : null;
  }

  async findByClientId(clientId: string): Promise<PortalAccount | null> {
    const row = (await (this.db as any).portalAccount.findUnique({ where: { clientId } })) as PortalAccountRow | null;
    return row ? mapRow(row) : null;
  }

  async create(input: CreatePortalAccountInput): Promise<PortalAccount> {
    const row = (await (this.db as any).portalAccount.create({
      data: {
        clientId: input.clientId,
        dni: input.dni,
        passwordHash: input.passwordHash,
      },
    })) as PortalAccountRow;
    return mapRow(row);
  }

  async update(id: string, patch: UpdatePortalAccountInput): Promise<PortalAccount> {
    const data: Record<string, unknown> = {};
    if (patch.dni !== undefined) data['dni'] = patch.dni;
    if (patch.passwordHash !== undefined) data['passwordHash'] = patch.passwordHash;
    if (patch.status !== undefined) data['status'] = patch.status;
    if (patch.mustChangePassword !== undefined) data['mustChangePassword'] = patch.mustChangePassword;
    if (patch.lastLoginAt !== undefined) data['lastLoginAt'] = patch.lastLoginAt;

    const row = (await (this.db as any).portalAccount.update({ where: { id }, data })) as PortalAccountRow;
    return mapRow(row);
  }

  async delete(id: string): Promise<void> {
    await (this.db as any).portalAccount.delete({ where: { id } });
  }

  async list(query: PaginatedQuery): Promise<PaginatedResult<PortalAccount>> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 25;
    const [rows, total] = await Promise.all([
      (this.db as any).portalAccount.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }) as Promise<PortalAccountRow[]>,
      (this.db as any).portalAccount.count() as Promise<number>,
    ]);
    return { data: rows.map(mapRow), total, page, limit };
  }

  /** portal-promos (`audience-preview`) — UNA query agregada, ver el port. */
  async countByClientIds(clientIds: string[]): Promise<number> {
    if (clientIds.length === 0) return 0;
    return (this.db as any).portalAccount.count({ where: { clientId: { in: clientIds } } }) as Promise<number>;
  }

  /** portal-notification-inbox — SIN mirar `pushPreference`, ver el docblock del port. */
  async listByClientIds(clientIds?: string[]): Promise<PortalAccountClientRef[]> {
    if (clientIds && clientIds.length === 0) return [];
    const rows = (await (this.db as any).portalAccount.findMany({
      where: clientIds ? { clientId: { in: clientIds } } : {},
      select: { id: true, clientId: true },
    })) as { id: string; clientId: string }[];
    return rows.map((r) => ({ accountId: r.id, clientId: r.clientId }));
  }
}
