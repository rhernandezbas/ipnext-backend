import { prisma } from '../../database/prisma';
import { Project } from '@domain/entities/project';
import { ProjectRepository } from '@domain/ports/ProjectRepository';

export class PrismaProjectRepository implements ProjectRepository {
  async list(): Promise<Project[]> {
    const projects = await prisma.project.findMany({
      orderBy: { createdAt: 'desc' },
      include: { tasks: { select: { status: true } } },
    });

    return projects.map(p => ({
      id: p.id,
      title: p.title,
      description: p.description,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      taskCounts: {
        nuevo: p.tasks.filter(t => t.status === 'pending').length,
        enProgreso: p.tasks.filter(t => t.status === 'in_progress').length,
        hecho: p.tasks.filter(t => t.status === 'completed').length,
        total: p.tasks.length,
      },
    }));
  }

  async get(id: string): Promise<Project | null> {
    const p = await prisma.project.findUnique({
      where: { id },
      include: { tasks: { select: { status: true } } },
    });
    if (!p) return null;
    return {
      id: p.id,
      title: p.title,
      description: p.description,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      taskCounts: {
        nuevo: p.tasks.filter(t => t.status === 'pending').length,
        enProgreso: p.tasks.filter(t => t.status === 'in_progress').length,
        hecho: p.tasks.filter(t => t.status === 'completed').length,
        total: p.tasks.length,
      },
    };
  }

  async create(data: Pick<Project, 'title' | 'description'>): Promise<Project> {
    const p = await prisma.project.create({
      data: { title: data.title, description: data.description ?? null },
    });
    return {
      id: p.id,
      title: p.title,
      description: p.description,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      taskCounts: { nuevo: 0, enProgreso: 0, hecho: 0, total: 0 },
    };
  }

  async update(id: string, data: Partial<Pick<Project, 'title' | 'description'>>): Promise<Project | null> {
    try {
      const p = await prisma.project.update({
        where: { id },
        data,
        include: { tasks: { select: { status: true } } },
      });
      return {
        id: p.id,
        title: p.title,
        description: p.description,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
        taskCounts: {
          nuevo: p.tasks.filter(t => t.status === 'pending').length,
          enProgreso: p.tasks.filter(t => t.status === 'in_progress').length,
          hecho: p.tasks.filter(t => t.status === 'completed').length,
          total: p.tasks.length,
        },
      };
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await prisma.project.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }
}
