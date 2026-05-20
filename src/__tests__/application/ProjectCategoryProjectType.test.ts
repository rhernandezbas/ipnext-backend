import { InMemoryProjectCategoryRepository } from '../../infrastructure/adapters/in-memory/InMemoryProjectCategoryRepository';
import { InMemoryProjectTypeRepository } from '../../infrastructure/adapters/in-memory/InMemoryProjectTypeRepository';
import { ListProjectCategory } from '../../application/use-cases/ListProjectCategory';
import { GetProjectCategory } from '../../application/use-cases/GetProjectCategory';
import { CreateProjectCategory } from '../../application/use-cases/CreateProjectCategory';
import { UpdateProjectCategory } from '../../application/use-cases/UpdateProjectCategory';
import { DeleteProjectCategory } from '../../application/use-cases/DeleteProjectCategory';
import { ListProjectType } from '../../application/use-cases/ListProjectType';
import { CreateProjectType } from '../../application/use-cases/CreateProjectType';
import {
  ProjectCategoryNotFoundError,
  ProjectCategoryNameConflictError,
  ProjectTypeNotFoundError,
  ProjectTypeNameConflictError,
} from '../../domain/errors/scheduling';

// ─── ProjectCategory ──────────────────────────────────────────────────────────

describe('ProjectCategory CRUD', () => {
  it('list returns empty array initially', async () => {
    const repo = new InMemoryProjectCategoryRepository();
    const result = await new ListProjectCategory(repo).execute();
    expect(result).toHaveLength(0);
  });

  it('create + get returns item', async () => {
    const repo = new InMemoryProjectCategoryRepository();
    const created = await new CreateProjectCategory(repo).execute({ name: 'Cat A', description: null });
    const found = await new GetProjectCategory(repo).execute(created.id);
    expect(found.name).toBe('Cat A');
  });

  it('create throws on duplicate name', async () => {
    const repo = new InMemoryProjectCategoryRepository();
    await new CreateProjectCategory(repo).execute({ name: 'Cat A' });
    await expect(new CreateProjectCategory(repo).execute({ name: 'Cat A' })).rejects.toThrow(ProjectCategoryNameConflictError);
  });

  it('get throws on unknown id', async () => {
    const repo = new InMemoryProjectCategoryRepository();
    await expect(new GetProjectCategory(repo).execute('nope')).rejects.toThrow(ProjectCategoryNotFoundError);
  });

  it('update changes name', async () => {
    const repo = new InMemoryProjectCategoryRepository();
    const created = await new CreateProjectCategory(repo).execute({ name: 'OldName' });
    const updated = await new UpdateProjectCategory(repo).execute(created.id, { name: 'NewName' });
    expect(updated.name).toBe('NewName');
  });

  it('update throws on unknown id', async () => {
    const repo = new InMemoryProjectCategoryRepository();
    await expect(new UpdateProjectCategory(repo).execute('nope', { name: 'X' })).rejects.toThrow(ProjectCategoryNotFoundError);
  });

  it('delete removes item', async () => {
    const repo = new InMemoryProjectCategoryRepository();
    const created = await new CreateProjectCategory(repo).execute({ name: 'Cat B' });
    await new DeleteProjectCategory(repo).execute(created.id);
    await expect(new GetProjectCategory(repo).execute(created.id)).rejects.toThrow(ProjectCategoryNotFoundError);
  });
});

// ─── ProjectType ──────────────────────────────────────────────────────────────

describe('ProjectType CRUD', () => {
  it('list returns empty array initially', async () => {
    const repo = new InMemoryProjectTypeRepository();
    const result = await new ListProjectType(repo).execute();
    expect(result).toHaveLength(0);
  });

  it('create + list returns item', async () => {
    const repo = new InMemoryProjectTypeRepository();
    await new CreateProjectType(repo).execute({ name: 'Instalacion' });
    const list = await new ListProjectType(repo).execute();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Instalacion');
  });

  it('create throws on duplicate name', async () => {
    const repo = new InMemoryProjectTypeRepository();
    await new CreateProjectType(repo).execute({ name: 'Type A' });
    await expect(new CreateProjectType(repo).execute({ name: 'Type A' })).rejects.toThrow(ProjectTypeNameConflictError);
  });

  it('get throws on unknown id', async () => {
    const repo = new InMemoryProjectTypeRepository();
    const { GetProjectType } = require('../../application/use-cases/GetProjectType');
    await expect(new GetProjectType(repo).execute('nope')).rejects.toThrow(ProjectTypeNotFoundError);
  });
});
