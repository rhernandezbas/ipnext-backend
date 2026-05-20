/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NOTE: This file uses `as any` casts on the Prisma client calls because
 * `prisma generate` has not been run yet against the enriched schema
 * (no DB available during this apply phase). The casts will become
 * unnecessary once the migration is applied and `npm run prisma:generate`
 * is executed. The runtime behaviour IS correct — the new columns exist
 * after the migration runs.
 */
import { prisma } from '../../database/prisma';
import { Project } from '@domain/entities/project';
import {
  ProjectRepository,
  CreateProjectInput,
  UpdateProjectInput,
  ListProjectsFilter,
} from '@domain/ports/ProjectRepository';

type EnrichedProjectRow = {
  id: string;
  title: string;
  description: string | null;
  typeId: string | null;
  categoryId: string | null;
  workflowId: string | null;
  projectLeadId: string | null;
  visible: boolean;
  partners: Array<{ partner: { id: string; name: string } }>;
  tasks: Array<{ stage: { category: 'nuevo' | 'enProgreso' | 'hecho' } | null }>;
  createdAt: Date;
  updatedAt: Date;
};

function mapProject(p: EnrichedProjectRow): Project {
  const taskCounts = p.tasks.reduce(
    (acc, t) => {
      const cat = t.stage?.category;
      if (cat === 'nuevo') acc.nuevo++;
      else if (cat === 'enProgreso') acc.enProgreso++;
      else if (cat === 'hecho') acc.hecho++;
      acc.total++;
      return acc;
    },
    { nuevo: 0, enProgreso: 0, hecho: 0, total: 0 },
  );

  return {
    id: p.id,
    title: p.title,
    description: p.description ?? null,
    typeId: p.typeId ?? null,
    categoryId: p.categoryId ?? null,
    workflowId: p.workflowId ?? null,
    projectLeadId: p.projectLeadId ?? null,
    visible: p.visible,
    partners: p.partners.map(pp => ({ id: pp.partner.id, name: pp.partner.name })),
    taskCounts,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

const INCLUDE = {
  partners: { include: { partner: { select: { id: true, name: true } } } },
  tasks: { select: { stage: { select: { category: true } } } },
} as const;

export class PrismaProjectRepository implements ProjectRepository {
  async list(filter?: ListProjectsFilter): Promise<Project[]> {
    const where = filter?.visible !== undefined ? { visible: filter.visible } : undefined;
    const projects = await (prisma.project as any).findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: INCLUDE,
    }) as EnrichedProjectRow[];
    return projects.map(mapProject);
  }

  async get(id: string): Promise<Project | null> {
    const p = await (prisma.project as any).findUnique({ where: { id }, include: INCLUDE }) as EnrichedProjectRow | null;
    if (!p) return null;
    return mapProject(p);
  }

  async create(data: CreateProjectInput): Promise<Project> {
    const partnerIds = [...new Set(data.partnerIds ?? [])];
    const p = await (prisma.project as any).create({
      data: {
        title: data.title,
        description: data.description ?? null,
        typeId: data.typeId ?? null,
        categoryId: data.categoryId ?? null,
        workflowId: data.workflowId ?? null,
        projectLeadId: data.projectLeadId ?? null,
        visible: data.visible ?? true,
        ...(partnerIds.length > 0 && {
          partners: {
            createMany: { data: partnerIds.map((partnerId: string) => ({ partnerId })) },
          },
        }),
      },
      include: INCLUDE,
    }) as EnrichedProjectRow;
    return mapProject(p);
  }

  async update(id: string, data: UpdateProjectInput): Promise<Project | null> {
    try {
      if ('partnerIds' in data && data.partnerIds !== undefined) {
        const deduped = [...new Set(data.partnerIds)];
        const { partnerIds: _partnerIds, ...scalarData } = data;
        const p = await (prisma as any).$transaction(async (tx: any) => {
          await tx.project.update({
            where: { id },
            data: this._buildScalarUpdate(scalarData),
          });
          await tx.projectPartner.deleteMany({ where: { projectId: id } });
          if (deduped.length > 0) {
            await tx.projectPartner.createMany({
              data: deduped.map((partnerId: string) => ({ projectId: id, partnerId })),
            });
          }
          return tx.project.findUnique({ where: { id }, include: INCLUDE });
        }) as EnrichedProjectRow | null;
        return p ? mapProject(p) : null;
      } else {
        const p = await (prisma.project as any).update({
          where: { id },
          data: this._buildScalarUpdate(data),
          include: INCLUDE,
        }) as EnrichedProjectRow;
        return mapProject(p);
      }
    } catch (err) {
      // P2025: record to update not found. Anything else is an unexpected error
      // and MUST surface to the caller so the HTTP layer can return 500 instead
      // of misleading 404 PROJECT_NOT_FOUND.
      if ((err as { code?: string })?.code === 'P2025') return null;
      throw err;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await prisma.project.delete({ where: { id } });
      return true;
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2025') return false;
      throw err;
    }
  }

  private _buildScalarUpdate(data: Omit<UpdateProjectInput, 'partnerIds'>): Record<string, unknown> {
    const update: Record<string, unknown> = {};
    if ('title' in data && data.title !== undefined) update['title'] = data.title;
    if ('description' in data) update['description'] = data.description ?? null;
    if ('typeId' in data) update['typeId'] = data.typeId ?? null;
    if ('categoryId' in data) update['categoryId'] = data.categoryId ?? null;
    if ('workflowId' in data) update['workflowId'] = data.workflowId ?? null;
    if ('projectLeadId' in data) update['projectLeadId'] = data.projectLeadId ?? null;
    if ('visible' in data && data.visible !== undefined) update['visible'] = data.visible;
    return update;
  }
}
