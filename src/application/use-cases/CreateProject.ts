import { Project } from '@domain/entities/project';
import { ProjectRepository, CreateProjectInput } from '@domain/ports/ProjectRepository';
import { ProjectCategoryRepository } from '@domain/ports/ProjectCategoryRepository';
import { ProjectTypeRepository } from '@domain/ports/ProjectTypeRepository';
import { WorkflowRepository } from '@domain/ports/WorkflowRepository';
import { AdminRepository } from '@domain/ports/AdminRepository';
import { PartnerRepository } from '@domain/ports/PartnerRepository';
import { ReferenceNotFoundError } from '@domain/errors/projects';

export class CreateProject {
  constructor(
    private readonly repo: ProjectRepository,
    private readonly categoryRepo: ProjectCategoryRepository,
    private readonly typeRepo: ProjectTypeRepository,
    private readonly workflowRepo: WorkflowRepository,
    private readonly adminRepo: AdminRepository,
    private readonly partnerRepo: PartnerRepository,
  ) {}

  async execute(data: CreateProjectInput): Promise<Project> {
    // Validate categoryId
    if (data.categoryId != null) {
      const cat = await this.categoryRepo.getById(data.categoryId);
      if (!cat) throw new ReferenceNotFoundError('category', data.categoryId);
    }

    // Validate typeId
    if (data.typeId != null) {
      const type = await this.typeRepo.getById(data.typeId);
      if (!type) throw new ReferenceNotFoundError('type', data.typeId);
    }

    // Validate workflowId
    if (data.workflowId != null) {
      const wf = await this.workflowRepo.getById(data.workflowId);
      if (!wf) throw new ReferenceNotFoundError('workflow', data.workflowId);
    }

    // Validate projectLeadId
    if (data.projectLeadId != null) {
      const admin = await this.adminRepo.findById(data.projectLeadId);
      if (!admin) throw new ReferenceNotFoundError('lead', data.projectLeadId);
    }

    // Validate and deduplicate partnerIds
    const deduped = [...new Set(data.partnerIds ?? [])];
    for (const pid of deduped) {
      const partner = await this.partnerRepo.findById(pid);
      if (!partner) throw new ReferenceNotFoundError('partner', pid);
    }

    return this.repo.create({ ...data, partnerIds: deduped });
  }
}
