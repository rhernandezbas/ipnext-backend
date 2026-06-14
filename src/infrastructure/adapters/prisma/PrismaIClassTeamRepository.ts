/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NOTE: `as any` casts on the Prisma client calls are used because the generated
 * client may lag the enriched schema until `npm run prisma:generate` runs against
 * the new migration. Runtime behaviour IS correct once the migration is applied.
 * Clone of PrismaIClassNodeRepository, keyed by `login` instead of `nodeId`.
 */
import { IClassTeam } from '@domain/entities/iclass-team';
import { IClassTeamRepository, UpsertTeamInput } from '@domain/ports/IClassTeamRepository';
import { prisma } from '../../database/prisma';

function mapRow(row: any): IClassTeam {
  return {
    id: row.id,
    login: row.login,
    name: row.name,
    thirdPartyCode: row.thirdPartyCode ?? null,
    active: row.active,
    selectable: row.selectable,
    lastSyncedAt: row.lastSyncedAt instanceof Date ? row.lastSyncedAt : new Date(row.lastSyncedAt),
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt),
  };
}

export class PrismaIClassTeamRepository implements IClassTeamRepository {
  async list(filter?: { active?: boolean; selectable?: boolean }): Promise<IClassTeam[]> {
    const where: Record<string, boolean> = {};
    if (filter?.active !== undefined) where['active'] = filter.active;
    if (filter?.selectable !== undefined) where['selectable'] = filter.selectable;
    const rows = await (prisma as any).iClassTeam.findMany({
      where: Object.keys(where).length > 0 ? where : undefined,
      orderBy: { name: 'asc' },
    });
    return rows.map(mapRow);
  }

  async getByLogin(login: string): Promise<IClassTeam | null> {
    const row = await (prisma as any).iClassTeam.findUnique({ where: { login } });
    return row ? mapRow(row) : null;
  }

  async upsertByLogin(
    team: UpsertTeamInput,
  ): Promise<{ status: 'created' | 'updated' | 'reactivated' }> {
    const now = new Date();

    const existing = await (prisma as any).iClassTeam.findUnique({ where: { login: team.login } });

    let status: 'created' | 'updated' | 'reactivated';
    if (!existing) {
      status = 'created';
    } else if (existing.active === false) {
      status = 'reactivated';
    } else {
      status = 'updated';
    }

    await (prisma as any).iClassTeam.upsert({
      where: { login: team.login },
      create: {
        login: team.login,
        name: team.name,
        thirdPartyCode: team.thirdPartyCode,
        active: team.active,
        selectable: team.selectable,
        lastSyncedAt: now,
      },
      update: {
        name: team.name,
        thirdPartyCode: team.thirdPartyCode,
        active: team.active,
        selectable: team.selectable,
        lastSyncedAt: now,
        updatedAt: now,
      },
    });

    return { status };
  }

  async markInactiveExcept(presentLogins: string[]): Promise<number> {
    const now = new Date();
    const result = await (prisma as any).iClassTeam.updateMany({
      where: { login: { notIn: presentLogins }, active: true },
      data: { active: false, lastSyncedAt: now, updatedAt: now },
    });
    return result.count;
  }
}
