import { randomUUID } from 'crypto';
import { Project } from '@domain/entities/project';
import {
  ProjectRepository,
  CreateProjectInput,
  UpdateProjectInput,
  ListProjectsFilter,
} from '@domain/ports/ProjectRepository';

export class InMemoryProjectRepository implements ProjectRepository {
  private projects: Map<string, Project & { partnerIds: string[] }> = new Map();
  /** Secondary cache: iclassSoTypeId → resolved soType object (set by seedIClassSoType). */
  private soTypeCache: Map<string, { id: string; code: string; description: string; active: boolean }> = new Map();

  async list(filter?: ListProjectsFilter): Promise<Project[]> {
    let items = Array.from(this.projects.values());
    if (filter?.visible !== undefined) {
      items = items.filter(p => p.visible === filter.visible);
    }
    return items.map(p => this._toProject(p));
  }

  async get(id: string): Promise<Project | null> {
    const p = this.projects.get(id);
    return p ? this._toProject(p) : null;
  }

  async create(data: CreateProjectInput): Promise<Project> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const partnerIds = [...new Set(data.partnerIds ?? [])];
    // Production (Prisma) resolves partner names via FK include; in-memory has
    // no partner repo reference, so fall back to using the id as the name.
    const partners = partnerIds.map(pid => ({ id: pid, name: pid }));
    const record = {
      id,
      title: data.title,
      description: data.description ?? null,
      typeId: data.typeId ?? null,
      categoryId: data.categoryId ?? null,
      workflowId: data.workflowId ?? null,
      projectLeadId: data.projectLeadId ?? null,
      visible: data.visible ?? true,
      partnerIds,
      partners,
      taskCounts: { nuevo: 0, enProgreso: 0, hecho: 0, total: 0 },
      iclassSoTypeId: null as string | null,
      iclassSoType: null as { id: string; code: string; description: string; active: boolean } | null,
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(id, record);
    return this._toProject(record);
  }

  async update(id: string, data: UpdateProjectInput): Promise<Project | null> {
    const existing = this.projects.get(id);
    if (!existing) return null;

    // Replace-set semantics: when partnerIds is explicitly present, keep partners
    // coherent with partnerIds (sync both). If an incoming id matches a cached
    // partner, reuse its name; otherwise fall back to using the id as the name.
    // Production (Prisma) resolves the name via the FK include; in-memory falls
    // back so tests can still assert the partners array reflects the new set.
    let newPartnerIds = existing.partnerIds;
    let newPartners = existing.partners;
    if (data.partnerIds !== undefined) {
      newPartnerIds = [...new Set(data.partnerIds)];
      newPartners = newPartnerIds.map(
        pid => existing.partners.find(p => p.id === pid) ?? { id: pid, name: pid },
      );
    }

    const updated = {
      ...existing,
      ...(data.title !== undefined && { title: data.title }),
      ...('description' in data && { description: data.description ?? null }),
      ...('typeId' in data && { typeId: data.typeId ?? null }),
      ...('categoryId' in data && { categoryId: data.categoryId ?? null }),
      ...('workflowId' in data && { workflowId: data.workflowId ?? null }),
      ...('projectLeadId' in data && { projectLeadId: data.projectLeadId ?? null }),
      ...(data.visible !== undefined && { visible: data.visible }),
      partnerIds: newPartnerIds,
      partners: newPartners,
      updatedAt: new Date().toISOString(),
    };
    this.projects.set(id, updated);
    return this._toProject(updated);
  }

  async delete(id: string): Promise<boolean> {
    return this.projects.delete(id);
  }

  async updateIClassSoType(projectId: string, iclassSoTypeId: string | null): Promise<Project | null> {
    const existing = this.projects.get(projectId);
    if (!existing) return null;

    const soType = iclassSoTypeId !== null
      ? (this.soTypeCache.get(iclassSoTypeId) ?? null)
      : null;

    const updated = {
      ...existing,
      iclassSoTypeId,
      iclassSoType: soType,
      updatedAt: new Date().toISOString(),
    };
    this.projects.set(projectId, updated);
    return this._toProject(updated);
  }

  /**
   * Test helper: register an IClass SO type so that updateIClassSoType can
   * populate the inline iclassSoType field on the returned Project (mimics the
   * Prisma include in production).
   */
  seedIClassSoType(soType: { id: string; code: string; description: string; active: boolean }): void {
    this.soTypeCache.set(soType.id, { ...soType });
  }

  /**
   * Test helper: overwrite the cached taskCounts on a project. Production
   * (Prisma) computes these from a JOIN; in-memory has no scheduling repo
   * reference, so tests inject the counts directly.
   */
  seedTaskCounts(
    projectId: string,
    counts: { nuevo: number; enProgreso: number; hecho: number; total: number },
  ): void {
    const existing = this.projects.get(projectId);
    if (!existing) throw new Error(`Cannot seed taskCounts: project ${projectId} not found`);
    this.projects.set(projectId, { ...existing, taskCounts: { ...counts } });
  }

  /** Test helper: seed a project with specific partnerIds resolved to partner objects */
  seedWithPartners(
    project: Omit<Project, 'partners'> & { partnerIds: string[] },
    partnerMap: Record<string, string>,
  ): void {
    const record = {
      ...project,
      partners: project.partnerIds.map(pid => ({ id: pid, name: partnerMap[pid] ?? pid })),
    };
    this.projects.set(project.id, record);
  }

  private _toProject(p: Project & { partnerIds: string[] }): Project {
    return {
      id: p.id,
      title: p.title,
      description: p.description,
      typeId: p.typeId,
      categoryId: p.categoryId,
      workflowId: p.workflowId,
      projectLeadId: p.projectLeadId,
      visible: p.visible,
      partners: [...p.partners],
      taskCounts: p.taskCounts ? { ...p.taskCounts } : { nuevo: 0, enProgreso: 0, hecho: 0, total: 0 },
      iclassSoTypeId: p.iclassSoTypeId ?? null,
      iclassSoType: p.iclassSoType ? { ...p.iclassSoType } : null,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }
}
