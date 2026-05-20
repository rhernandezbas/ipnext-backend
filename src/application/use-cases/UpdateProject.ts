import { Project } from '@domain/entities/project';
import { ProjectRepository, UpdateProjectInput } from '@domain/ports/ProjectRepository';
import { ProjectCategoryRepository } from '@domain/ports/ProjectCategoryRepository';
import { ProjectTypeRepository } from '@domain/ports/ProjectTypeRepository';
import { WorkflowRepository } from '@domain/ports/WorkflowRepository';
import { AdminRepository } from '@domain/ports/AdminRepository';
import { PartnerRepository } from '@domain/ports/PartnerRepository';
import { ReferenceNotFoundError } from '@domain/errors/projects';

export class UpdateProject {
  constructor(
    private readonly repo: ProjectRepository,
    private readonly categoryRepo: ProjectCategoryRepository,
    private readonly typeRepo: ProjectTypeRepository,
    private readonly workflowRepo: WorkflowRepository,
    private readonly adminRepo: AdminRepository,
    private readonly partnerRepo: PartnerRepository,
  ) {}

  async execute(id: string, data: UpdateProjectInput): Promise<Project | null> {
    // Conditional FK lookups — only for fields present in the body (null = "clear", skip lookup)
    if ('categoryId' in data && data.categoryId != null) {
      const cat = await this.categoryRepo.getById(data.categoryId);
      if (!cat) throw new ReferenceNotFoundError('category', data.categoryId);
    }

    if ('typeId' in data && data.typeId != null) {
      const type = await this.typeRepo.getById(data.typeId);
      if (!type) throw new ReferenceNotFoundError('type', data.typeId);
    }

    if ('workflowId' in data && data.workflowId != null) {
      const wf = await this.workflowRepo.getById(data.workflowId);
      if (!wf) throw new ReferenceNotFoundError('workflow', data.workflowId);
    }

    if ('projectLeadId' in data && data.projectLeadId != null) {
      const admin = await this.adminRepo.findById(data.projectLeadId);
      if (!admin) throw new ReferenceNotFoundError('lead', data.projectLeadId);
    }

    // Validate and deduplicate partnerIds (only if explicitly present)
    let finalData = data;
    if ('partnerIds' in data && data.partnerIds !== undefined) {
      const deduped = [...new Set(data.partnerIds)];
      for (const pid of deduped) {
        const partner = await this.partnerRepo.findById(pid);
        if (!partner) throw new ReferenceNotFoundError('partner', pid);
      }
      finalData = { ...data, partnerIds: deduped };
    }

    return this.repo.update(id, finalData);
  }
}
