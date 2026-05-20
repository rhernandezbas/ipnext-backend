import { ListTasksFilterSchema } from '../../../application/dto/scheduling.dto';

describe('ListTasksFilterSchema', () => {
  it('accepts an empty object', () => {
    const result = ListTasksFilterSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('fails when stageIds contains an empty string', () => {
    const result = ListTasksFilterSchema.safeParse({ stageIds: [''] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toContain('stageIds');
  });

  it('accepts a full valid filter', () => {
    const result = ListTasksFilterSchema.safeParse({
      projectId: 'abc',
      stageIds: ['x', 'y'],
      q: 'test',
      partnerId: 'p1',
      assigneeId: 'a1',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stageIds).toEqual(['x', 'y']);
    }
  });

  it('strips unknown fields', () => {
    const result = ListTasksFilterSchema.safeParse({ unknownField: 'foo' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>)['unknownField']).toBeUndefined();
    }
  });
});
