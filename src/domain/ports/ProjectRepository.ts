import { Project } from '@domain/entities/project';

export interface CreateProjectInput {
  title: string;
  description?: string | null;
  typeId?: string | null;
  categoryId?: string | null;
  workflowId?: string | null;
  projectLeadId?: string | null;
  visible?: boolean;
  partnerIds?: string[];
}

export interface UpdateProjectInput extends Partial<CreateProjectInput> {}

export interface ListProjectsFilter {
  visible?: boolean;
}

export interface ProjectRepository {
  list(filter?: ListProjectsFilter): Promise<Project[]>;
  get(id: string): Promise<Project | null>;
  create(data: CreateProjectInput): Promise<Project>;
  update(id: string, data: UpdateProjectInput): Promise<Project | null>;
  delete(id: string): Promise<boolean>;
}
