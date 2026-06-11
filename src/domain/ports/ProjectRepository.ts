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

export interface UpdateProjectInput extends Partial<CreateProjectInput> {
  /** When present, sets whether the project allows equipment retirement. */
  allowsEquipmentRetirement?: boolean;
  /** When present, sets whether the project is a network (nodos) project (#40). */
  isNetworkProject?: boolean;
}

export interface ListProjectsFilter {
  visible?: boolean;
}

export interface ProjectRepository {
  list(filter?: ListProjectsFilter): Promise<Project[]>;
  get(id: string): Promise<Project | null>;
  create(data: CreateProjectInput): Promise<Project>;
  update(id: string, data: UpdateProjectInput): Promise<Project | null>;
  delete(id: string): Promise<boolean>;
  /**
   * Assigns or clears the IClass SO type mapping on a project.
   * Returns the updated Project (with iclassSoType populated), or null if the project is not found.
   */
  updateIClassSoType(projectId: string, iclassSoTypeId: string | null): Promise<Project | null>;
}
