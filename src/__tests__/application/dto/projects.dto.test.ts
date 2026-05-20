import { CreateProjectSchema, UpdateProjectSchema, ListProjectsQuerySchema } from '../../../application/dto/projects.dto';

const VALID_UUID = '00000000-0000-4000-a000-000000000001';

describe('CreateProjectSchema', () => {
  it('accepts minimal payload with title only', () => {
    const result = CreateProjectSchema.safeParse({ title: 'My Project' });
    expect(result.success).toBe(true);
  });

  it('rejects missing title', () => {
    const result = CreateProjectSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects empty/whitespace title', () => {
    const result = CreateProjectSchema.safeParse({ title: '   ' });
    expect(result.success).toBe(false);
  });

  it('rejects empty-string categoryId', () => {
    // IDs only need to be non-empty strings; existence is verified by the use
    // case via FK lookup (returns CATEGORY_NOT_FOUND).
    const result = CreateProjectSchema.safeParse({ title: 'T', categoryId: '' });
    expect(result.success).toBe(false);
  });

  it('accepts null categoryId', () => {
    const result = CreateProjectSchema.safeParse({ title: 'T', categoryId: null });
    expect(result.success).toBe(true);
  });

  it('accepts valid UUID categoryId', () => {
    const result = CreateProjectSchema.safeParse({ title: 'T', categoryId: VALID_UUID });
    expect(result.success).toBe(true);
  });

  it('rejects partnerIds as string (must be array)', () => {
    const result = CreateProjectSchema.safeParse({ title: 'T', partnerIds: 'x' });
    expect(result.success).toBe(false);
  });

  it('rejects partnerIds with empty-string elements', () => {
    const result = CreateProjectSchema.safeParse({ title: 'T', partnerIds: [''] });
    expect(result.success).toBe(false);
  });

  it('accepts partnerIds as array of UUIDs', () => {
    const result = CreateProjectSchema.safeParse({ title: 'T', partnerIds: [VALID_UUID] });
    expect(result.success).toBe(true);
  });

  it('rejects visible: "yes" (must be boolean)', () => {
    const result = CreateProjectSchema.safeParse({ title: 'T', visible: 'yes' });
    expect(result.success).toBe(false);
  });

  it('accepts all optional FK fields as null', () => {
    const result = CreateProjectSchema.safeParse({
      title: 'T',
      description: null,
      typeId: null,
      categoryId: null,
      workflowId: null,
      projectLeadId: null,
    });
    expect(result.success).toBe(true);
  });

  it('trims the title', () => {
    const result = CreateProjectSchema.safeParse({ title: '  Hello  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.title).toBe('Hello');
  });
});

describe('UpdateProjectSchema', () => {
  it('accepts empty object (all fields optional)', () => {
    const result = UpdateProjectSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('rejects empty-string typeId', () => {
    const result = UpdateProjectSchema.safeParse({ typeId: '' });
    expect(result.success).toBe(false);
  });

  it('accepts title only', () => {
    const result = UpdateProjectSchema.safeParse({ title: 'New Title' });
    expect(result.success).toBe(true);
  });
});

describe('ListProjectsQuerySchema', () => {
  it('accepts visible=true string', () => {
    const result = ListProjectsQuerySchema.safeParse({ visible: 'true' });
    expect(result.success).toBe(true);
  });

  it('accepts visible=false string', () => {
    const result = ListProjectsQuerySchema.safeParse({ visible: 'false' });
    expect(result.success).toBe(true);
  });

  it('rejects visible=yes', () => {
    const result = ListProjectsQuerySchema.safeParse({ visible: 'yes' });
    expect(result.success).toBe(false);
  });

  it('accepts empty object (no filter)', () => {
    const result = ListProjectsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });
});
