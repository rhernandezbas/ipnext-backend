import { StageCategory, Stage, Workflow } from '../../domain/entities/workflow';

// Task 2.1 – Assert shape of Workflow, Stage, StageCategory

describe('workflow domain types', () => {
  it('StageCategory is one of the three expected values', () => {
    const categories: StageCategory[] = ['nuevo', 'enProgreso', 'hecho'];
    expect(categories).toHaveLength(3);
  });

  it('Stage has required fields with correct types', () => {
    const stage: Stage = {
      id: 'stage-1',
      workflowId: 'wf-1',
      name: 'Nuevo',
      code: 'nuevo',
      category: 'nuevo',
      order: 0,
      color: null,
    };
    expect(stage.id).toBe('stage-1');
    expect(stage.workflowId).toBe('wf-1');
    expect(stage.name).toBe('Nuevo');
    expect(stage.category).toBe('nuevo');
    expect(stage.order).toBe(0);
  });

  it('Workflow has required fields with stages array', () => {
    const wf: Workflow = {
      id: 'wf-1',
      name: 'Default',
      description: null,
      stages: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(wf.id).toBe('wf-1');
    expect(Array.isArray(wf.stages)).toBe(true);
  });
});
