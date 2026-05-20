import {
  ReplaceTemplateItemsSchema,
  AddChecklistItemSchema,
  UpdateChecklistItemSchema,
  ReorderChecklistSchema,
  AssignTemplateSchema,
} from '../../../application/dto/checklists.dto';

describe('checklists.dto — ReplaceTemplateItemsSchema', () => {
  it('parses valid items array', () => {
    const result = ReplaceTemplateItemsSchema.safeParse({ items: [{ text: 'Step 1' }] });
    expect(result.success).toBe(true);
  });

  it('rejects empty text', () => {
    const result = ReplaceTemplateItemsSchema.safeParse({ items: [{ text: '' }] });
    expect(result.success).toBe(false);
  });

  it('rejects text > 500 chars', () => {
    const result = ReplaceTemplateItemsSchema.safeParse({ items: [{ text: 'a'.repeat(501) }] });
    expect(result.success).toBe(false);
  });

  it('accepts empty items array', () => {
    const result = ReplaceTemplateItemsSchema.safeParse({ items: [] });
    expect(result.success).toBe(true);
  });
});

describe('checklists.dto — AddChecklistItemSchema', () => {
  it('parses valid text', () => {
    const result = AddChecklistItemSchema.safeParse({ text: 'Do something' });
    expect(result.success).toBe(true);
  });

  it('rejects empty text', () => {
    const result = AddChecklistItemSchema.safeParse({ text: '' });
    expect(result.success).toBe(false);
  });

  it('rejects text > 500 chars', () => {
    const result = AddChecklistItemSchema.safeParse({ text: 'x'.repeat(501) });
    expect(result.success).toBe(false);
  });
});

describe('checklists.dto — UpdateChecklistItemSchema', () => {
  it('parses valid text', () => {
    const result = UpdateChecklistItemSchema.safeParse({ text: 'Updated text' });
    expect(result.success).toBe(true);
  });

  it('rejects empty text', () => {
    const result = UpdateChecklistItemSchema.safeParse({ text: '' });
    expect(result.success).toBe(false);
  });
});

describe('checklists.dto — ReorderChecklistSchema', () => {
  it('parses valid orderedIds', () => {
    const result = ReorderChecklistSchema.safeParse({ orderedIds: ['id-1', 'id-2'] });
    expect(result.success).toBe(true);
  });

  it('accepts empty orderedIds', () => {
    const result = ReorderChecklistSchema.safeParse({ orderedIds: [] });
    expect(result.success).toBe(true);
  });

  it('rejects IDs that are empty strings', () => {
    const result = ReorderChecklistSchema.safeParse({ orderedIds: [''] });
    expect(result.success).toBe(false);
  });

  it('does NOT use .uuid() — non-UUID string passes', () => {
    const result = ReorderChecklistSchema.safeParse({ orderedIds: ['not-a-uuid', 'also-not-uuid'] });
    expect(result.success).toBe(true);
  });
});

describe('checklists.dto — AssignTemplateSchema', () => {
  it('parses valid templateId', () => {
    const result = AssignTemplateSchema.safeParse({ templateId: 'tpl-123' });
    expect(result.success).toBe(true);
  });

  it('rejects empty templateId', () => {
    const result = AssignTemplateSchema.safeParse({ templateId: '' });
    expect(result.success).toBe(false);
  });

  it('does NOT use .uuid() — non-UUID template ID passes', () => {
    const result = AssignTemplateSchema.safeParse({ templateId: 'not-a-uuid' });
    expect(result.success).toBe(true);
  });
});
