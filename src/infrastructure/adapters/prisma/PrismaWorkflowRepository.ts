import { Workflow, Stage } from '@domain/entities/workflow';
import { WorkflowRepository } from '@domain/ports/WorkflowRepository';
import { prisma } from '../../database/prisma';

function toStage(row: any): Stage {
  return {
    id: row.id,
    workflowId: row.workflowId,
    name: row.name,
    category: row.category,
    order: row.order,
    color: row.color ?? null,
  };
}

function toWorkflow(row: any): Workflow {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    stages: (row.stages ?? [])
      .map(toStage)
      .sort((a: Stage, b: Stage) => a.order - b.order),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

const INCLUDE_STAGES = { stages: true } as const;

export class PrismaWorkflowRepository implements WorkflowRepository {
  async list(): Promise<Workflow[]> {
    const rows = await prisma.workflow.findMany({ include: INCLUDE_STAGES, orderBy: { createdAt: 'asc' } });
    return rows.map(toWorkflow);
  }

  async getById(id: string): Promise<Workflow | null> {
    const row = await prisma.workflow.findUnique({ where: { id }, include: INCLUDE_STAGES });
    return row ? toWorkflow(row) : null;
  }

  async getByName(name: string): Promise<Workflow | null> {
    const row = await prisma.workflow.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      include: INCLUDE_STAGES,
    });
    return row ? toWorkflow(row) : null;
  }

  async create(data: {
    name: string;
    description: string | null;
    stages: Array<Pick<Stage, 'name' | 'category' | 'order'>>;
  }): Promise<Workflow> {
    const row = await prisma.workflow.create({
      include: INCLUDE_STAGES,
      data: {
        name: data.name,
        description: data.description,
        stages: {
          create: data.stages.map(s => ({
            name: s.name,
            category: s.category as any,
            order: s.order,
          })),
        },
      },
    });
    return toWorkflow(row);
  }

  async update(id: string, data: Partial<Pick<Workflow, 'name' | 'description'>>): Promise<Workflow | null> {
    try {
      const row = await prisma.workflow.update({
        where: { id },
        include: INCLUDE_STAGES,
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.description !== undefined && { description: data.description }),
        },
      });
      return toWorkflow(row);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await prisma.workflow.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }
}
