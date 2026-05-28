/**
 * TDD — AssignIClassSoTypeToProject use case
 * Covers REQ-PROJ-3, REQ-PROJ-4, REQ-PROJ-5, REQ-PROJ-6 scenarios.
 */
import { InMemoryProjectRepository } from '../../infrastructure/adapters/in-memory/InMemoryProjectRepository';
import { InMemoryIClassSoTypeRepository } from '../../infrastructure/adapters/in-memory/InMemoryIClassSoTypeRepository';
import { AssignIClassSoTypeToProject } from '../../application/use-cases/AssignIClassSoTypeToProject';
import {
  IClassSoTypeNotFoundError,
  IClassSoTypeInactiveError,
} from '../../domain/errors/iclass';
import { ProjectNotFoundError } from '../../domain/errors/projects';

async function setup() {
  const projects = new InMemoryProjectRepository();
  const soTypes = new InMemoryIClassSoTypeRepository();

  // Seed a project
  const project = await projects.create({ title: 'Fibra Óptica Norte' });

  // Seed an active SO type
  await soTypes.upsertByCode({ code: 'INSTALL', description: 'Installation' });
  const activeType = await soTypes.getByCode('INSTALL');

  // Seed an inactive SO type
  await soTypes.upsertByCode({ code: 'OLD_TYPE', description: 'Old Type' });
  await soTypes.markInactiveExcept(['INSTALL']); // deactivates OLD_TYPE
  const inactiveType = await soTypes.getByCode('OLD_TYPE');

  // Register the active soType in the project repo cache for updateIClassSoType
  projects.seedIClassSoType({ id: activeType!.id, code: activeType!.code, description: activeType!.description, active: activeType!.active });

  const useCase = new AssignIClassSoTypeToProject(projects, soTypes);

  return { projects, soTypes, project, activeType: activeType!, inactiveType: inactiveType!, useCase };
}

describe('AssignIClassSoTypeToProject', () => {
  it('assigns a valid active type → returns updated project with iclassSoType', async () => {
    const { project, activeType, useCase } = await setup();

    const result = await useCase.execute(project.id, activeType.id);

    expect(result.iclassSoTypeId).toBe(activeType.id);
    expect(result.iclassSoType).toMatchObject({
      id: activeType.id,
      code: 'INSTALL',
      active: true,
    });
  });

  it('set to null → clears the mapping, iclassSoType is null', async () => {
    const { project, activeType, useCase } = await setup();

    // First assign
    await useCase.execute(project.id, activeType.id);
    // Then clear
    const result = await useCase.execute(project.id, null);

    expect(result.iclassSoTypeId).toBeNull();
    expect(result.iclassSoType).toBeNull();
  });

  it('non-existent id → throws IClassSoTypeNotFoundError', async () => {
    const { project, useCase } = await setup();

    await expect(useCase.execute(project.id, 'non-existent-uuid')).rejects.toBeInstanceOf(
      IClassSoTypeNotFoundError,
    );
  });

  it('inactive type id → throws IClassSoTypeInactiveError', async () => {
    const { project, inactiveType, useCase } = await setup();

    await expect(useCase.execute(project.id, inactiveType.id)).rejects.toBeInstanceOf(
      IClassSoTypeInactiveError,
    );
  });

  it('inactive type id → error carries the type code', async () => {
    const { project, inactiveType, useCase } = await setup();

    const err = await useCase.execute(project.id, inactiveType.id).catch((e: unknown) => e) as IClassSoTypeInactiveError;
    expect(err).toBeInstanceOf(IClassSoTypeInactiveError);
    expect(err.iclassSoTypeCode).toBe('OLD_TYPE');
  });

  it('non-existent project id → throws ProjectNotFoundError', async () => {
    const { activeType, useCase } = await setup();

    await expect(useCase.execute('non-existent-project', activeType.id)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });

  it('null assignment on non-existent project → throws ProjectNotFoundError', async () => {
    const { useCase } = await setup();

    await expect(useCase.execute('non-existent-project', null)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });
});
