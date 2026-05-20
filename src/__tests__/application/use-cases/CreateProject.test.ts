import { InMemoryProjectRepository } from '../../../infrastructure/adapters/in-memory/InMemoryProjectRepository';
import { InMemoryProjectCategoryRepository } from '../../../infrastructure/adapters/in-memory/InMemoryProjectCategoryRepository';
import { InMemoryProjectTypeRepository } from '../../../infrastructure/adapters/in-memory/InMemoryProjectTypeRepository';
import { InMemoryWorkflowRepository } from '../../../infrastructure/adapters/in-memory/InMemoryWorkflowRepository';
import { InMemoryAdminRepository } from '../../../infrastructure/adapters/in-memory/InMemoryAdminRepository';
import { InMemoryPartnerRepository } from '../../../infrastructure/adapters/in-memory/InMemoryPartnerRepository';
import { CreateProject } from '../../../application/use-cases/CreateProject';
import { ReferenceNotFoundError } from '../../../domain/errors/projects';

const VALID_UUID = '00000000-0000-4000-a000-000000000001';

async function buildDeps() {
  const projectRepo = new InMemoryProjectRepository();
  const categoryRepo = new InMemoryProjectCategoryRepository();
  const typeRepo = new InMemoryProjectTypeRepository();
  const workflowRepo = new InMemoryWorkflowRepository();
  const adminRepo = new InMemoryAdminRepository();
  const partnerRepo = new InMemoryPartnerRepository();

  // Seed a category, type, workflow
  const cat = await categoryRepo.create({ name: 'Cat1', description: null });
  const type = await typeRepo.create({ name: 'Type1', description: null });
  const wf = await workflowRepo.create({ name: 'Default', description: null, stages: [] });

  return { projectRepo, categoryRepo, typeRepo, workflowRepo, adminRepo, partnerRepo, cat, type, wf };
}

describe('CreateProject use case', () => {
  it('creates a project with title only (no FKs)', async () => {
    const { projectRepo, categoryRepo, typeRepo, workflowRepo, adminRepo, partnerRepo } = await buildDeps();
    const uc = new CreateProject(projectRepo, categoryRepo, typeRepo, workflowRepo, adminRepo, partnerRepo);
    const result = await uc.execute({ title: 'New Project' });
    expect(result.id).toBeDefined();
    expect(result.title).toBe('New Project');
    expect(result.visible).toBe(true);
    expect(result.partners).toEqual([]);
    expect(result.taskCounts).toEqual({ nuevo: 0, enProgreso: 0, hecho: 0, total: 0 });
  });

  it('creates a project with all FKs valid', async () => {
    const { projectRepo, categoryRepo, typeRepo, workflowRepo, adminRepo, partnerRepo, cat, type, wf } = await buildDeps();
    // Get existing admin from InMemoryAdminRepository (has seeded admin with id '1')
    const admin = await adminRepo.findById('1');
    const partner = await partnerRepo.findById('1');
    const uc = new CreateProject(projectRepo, categoryRepo, typeRepo, workflowRepo, adminRepo, partnerRepo);
    const result = await uc.execute({
      title: 'Full Project',
      categoryId: cat.id,
      typeId: type.id,
      workflowId: wf.id,
      projectLeadId: admin!.id,
      partnerIds: [partner!.id],
    });
    expect(result.categoryId).toBe(cat.id);
    expect(result.typeId).toBe(type.id);
    expect(result.workflowId).toBe(wf.id);
    expect(result.projectLeadId).toBe(admin!.id);
  });

  it('throws ReferenceNotFoundError for unknown categoryId', async () => {
    const { projectRepo, categoryRepo, typeRepo, workflowRepo, adminRepo, partnerRepo } = await buildDeps();
    const uc = new CreateProject(projectRepo, categoryRepo, typeRepo, workflowRepo, adminRepo, partnerRepo);
    await expect(
      uc.execute({ title: 'T', categoryId: VALID_UUID }),
    ).rejects.toMatchObject({ reference: 'category' });
  });

  it('throws ReferenceNotFoundError for unknown typeId', async () => {
    const { projectRepo, categoryRepo, typeRepo, workflowRepo, adminRepo, partnerRepo } = await buildDeps();
    const uc = new CreateProject(projectRepo, categoryRepo, typeRepo, workflowRepo, adminRepo, partnerRepo);
    await expect(
      uc.execute({ title: 'T', typeId: VALID_UUID }),
    ).rejects.toMatchObject({ reference: 'type' });
  });

  it('throws ReferenceNotFoundError for unknown workflowId', async () => {
    const { projectRepo, categoryRepo, typeRepo, workflowRepo, adminRepo, partnerRepo } = await buildDeps();
    const uc = new CreateProject(projectRepo, categoryRepo, typeRepo, workflowRepo, adminRepo, partnerRepo);
    await expect(
      uc.execute({ title: 'T', workflowId: VALID_UUID }),
    ).rejects.toMatchObject({ reference: 'workflow' });
  });

  it('throws ReferenceNotFoundError for unknown projectLeadId', async () => {
    const { projectRepo, categoryRepo, typeRepo, workflowRepo, adminRepo, partnerRepo } = await buildDeps();
    const uc = new CreateProject(projectRepo, categoryRepo, typeRepo, workflowRepo, adminRepo, partnerRepo);
    await expect(
      uc.execute({ title: 'T', projectLeadId: VALID_UUID }),
    ).rejects.toMatchObject({ reference: 'lead' });
  });

  it('throws ReferenceNotFoundError for unknown partnerId in partnerIds', async () => {
    const { projectRepo, categoryRepo, typeRepo, workflowRepo, adminRepo, partnerRepo } = await buildDeps();
    const uc = new CreateProject(projectRepo, categoryRepo, typeRepo, workflowRepo, adminRepo, partnerRepo);
    await expect(
      uc.execute({ title: 'T', partnerIds: [VALID_UUID] }),
    ).rejects.toMatchObject({ reference: 'partner' });
  });

  it('deduplicates partnerIds before validation', async () => {
    const { projectRepo, categoryRepo, typeRepo, workflowRepo, adminRepo, partnerRepo } = await buildDeps();
    const partner = await partnerRepo.findById('1');
    const uc = new CreateProject(projectRepo, categoryRepo, typeRepo, workflowRepo, adminRepo, partnerRepo);
    // Should not throw with duplicates
    const result = await uc.execute({ title: 'T', partnerIds: [partner!.id, partner!.id] });
    expect(result.id).toBeDefined();
  });

  it('throws error that is instanceof ReferenceNotFoundError', async () => {
    const { projectRepo, categoryRepo, typeRepo, workflowRepo, adminRepo, partnerRepo } = await buildDeps();
    const uc = new CreateProject(projectRepo, categoryRepo, typeRepo, workflowRepo, adminRepo, partnerRepo);
    await expect(
      uc.execute({ title: 'T', categoryId: VALID_UUID }),
    ).rejects.toBeInstanceOf(ReferenceNotFoundError);
  });
});
