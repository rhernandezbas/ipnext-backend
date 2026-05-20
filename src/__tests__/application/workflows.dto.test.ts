import {
  CreateWorkflowSchema,
  CreateStageSchema,
  ReorderStagesSchema,
  CreateProjectCategorySchema,
  CreateProjectTypeSchema,
  UpdateWorkflowSchema,
  UpdateProjectCategorySchema,
  UpdateProjectTypeSchema,
} from '../../application/dto/workflows.dto';

// Task 3.1 — failing tests for DTO schemas

describe('CreateStageSchema', () => {
  it('valid stage passes', () => {
    const result = CreateStageSchema.safeParse({ name: 'Nuevo', category: 'nuevo', order: 0 });
    expect(result.success).toBe(true);
  });

  it('invalid category fails', () => {
    const result = CreateStageSchema.safeParse({ name: 'Nuevo', category: 'DONE', order: 0 });
    expect(result.success).toBe(false);
  });

  it('missing name fails', () => {
    const result = CreateStageSchema.safeParse({ category: 'nuevo', order: 0 });
    expect(result.success).toBe(false);
  });

  it('negative order fails', () => {
    const result = CreateStageSchema.safeParse({ name: 'X', category: 'nuevo', order: -1 });
    expect(result.success).toBe(false);
  });

  it('non-integer order fails', () => {
    const result = CreateStageSchema.safeParse({ name: 'X', category: 'nuevo', order: 1.5 });
    expect(result.success).toBe(false);
  });
});

describe('CreateWorkflowSchema', () => {
  it('valid minimal payload (no stages) passes', () => {
    const result = CreateWorkflowSchema.safeParse({ name: 'My Workflow' });
    expect(result.success).toBe(true);
  });

  it('valid with stages passes', () => {
    const result = CreateWorkflowSchema.safeParse({
      name: 'My Workflow',
      description: 'desc',
      stages: [{ name: 'Nuevo', category: 'nuevo', order: 0 }],
    });
    expect(result.success).toBe(true);
  });

  it('empty name fails', () => {
    const result = CreateWorkflowSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });

  it('stage with invalid category fails', () => {
    const result = CreateWorkflowSchema.safeParse({
      name: 'X',
      stages: [{ name: 'Nuevo', category: 'invalid', order: 0 }],
    });
    expect(result.success).toBe(false);
  });

  it('empty stages array passes', () => {
    const result = CreateWorkflowSchema.safeParse({ name: 'X', stages: [] });
    expect(result.success).toBe(true);
  });
});

describe('UpdateWorkflowSchema', () => {
  it('partial name only passes', () => {
    const result = UpdateWorkflowSchema.safeParse({ name: 'New name' });
    expect(result.success).toBe(true);
  });

  it('empty body passes (all optional)', () => {
    const result = UpdateWorkflowSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('empty string name fails', () => {
    const result = UpdateWorkflowSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });
});

describe('ReorderStagesSchema', () => {
  it('valid list of UUIDs passes', () => {
    const result = ReorderStagesSchema.safeParse({
      order: ['550e8400-e29b-41d4-a716-446655440001', '550e8400-e29b-41d4-a716-446655440002'],
    });
    expect(result.success).toBe(true);
  });

  it('non-UUID string in order fails', () => {
    const result = ReorderStagesSchema.safeParse({ order: ['not-a-uuid'] });
    expect(result.success).toBe(false);
  });

  it('empty array fails (min 1)', () => {
    const result = ReorderStagesSchema.safeParse({ order: [] });
    expect(result.success).toBe(false);
  });
});

describe('CreateProjectCategorySchema', () => {
  it('valid passes', () => {
    const result = CreateProjectCategorySchema.safeParse({ name: 'Cat A' });
    expect(result.success).toBe(true);
  });

  it('empty name fails', () => {
    const result = CreateProjectCategorySchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });
});

describe('UpdateProjectCategorySchema', () => {
  it('empty body passes (partial)', () => {
    const result = UpdateProjectCategorySchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe('CreateProjectTypeSchema', () => {
  it('valid passes', () => {
    const result = CreateProjectTypeSchema.safeParse({ name: 'Instalacion' });
    expect(result.success).toBe(true);
  });

  it('empty name fails', () => {
    const result = CreateProjectTypeSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });
});

describe('UpdateProjectTypeSchema', () => {
  it('empty body passes (partial)', () => {
    const result = UpdateProjectTypeSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});
