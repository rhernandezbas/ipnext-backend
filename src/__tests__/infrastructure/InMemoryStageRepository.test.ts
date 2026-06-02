/**
 * TDD — InMemoryStageRepository: code persistence + findByCode (T-05)
 * REQ-CODE-4: add persists code; findByCode resolves by (code, workflowId).
 */
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { Stage } from '@domain/entities/workflow';

describe('InMemoryStageRepository — code field (T-05)', () => {
  it('add with code persists it and findByCode returns the stage', async () => {
    const repo = new InMemoryStageRepository();
    const stage = await repo.add('wf-1', {
      name: 'Registrado en IClass',
      code: 'registered_in_iclass',
      category: 'enProgreso',
      order: 5,
    });

    expect(stage.code).toBe('registered_in_iclass');

    const found = await repo.findByCode('registered_in_iclass', 'wf-1');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(stage.id);
    expect(found!.code).toBe('registered_in_iclass');
  });

  it('findByCode with a different workflowId returns null (unique per workflow)', async () => {
    const repo = new InMemoryStageRepository();
    await repo.add('wf-1', {
      name: 'Registrado en IClass',
      code: 'registered_in_iclass',
      category: 'enProgreso',
      order: 5,
    });

    const result = await repo.findByCode('registered_in_iclass', 'wf-other');
    expect(result).toBeNull();
  });

  it('findByCode with non-existent code returns null', async () => {
    const repo = new InMemoryStageRepository();
    const result = await repo.findByCode('does_not_exist', 'wf-1');
    expect(result).toBeNull();
  });

  it('addDirect with code makes the stage findable by code', async () => {
    const repo = new InMemoryStageRepository();
    const stage: Stage = {
      id: 'stage-direct',
      workflowId: 'wf-direct',
      name: 'Enviar a IClass',
      code: 'send_to_iclass',
      category: 'enProgreso',
      order: 4,
      color: null,
    };
    repo.addDirect(stage);

    const found = await repo.findByCode('send_to_iclass', 'wf-direct');
    expect(found).not.toBeNull();
    expect(found!.id).toBe('stage-direct');
  });
});
