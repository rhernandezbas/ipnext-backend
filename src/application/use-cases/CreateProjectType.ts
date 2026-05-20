import { ProjectTypeRepository } from '@domain/ports/ProjectTypeRepository';
import { ProjectType } from '@domain/entities/projectType';
import { ProjectTypeNameConflictError } from '@domain/errors/scheduling';

export class CreateProjectType {
  constructor(private readonly repo: ProjectTypeRepository) {}
  async execute(data: { name: string; description?: string | null }): Promise<ProjectType> {
    const existing = await this.repo.getByName(data.name);
    if (existing) throw new ProjectTypeNameConflictError(data.name);
    return this.repo.create({ name: data.name, description: data.description ?? null });
  }
}
