import { ReplaceTaskTemplateItems } from '../../../application/use-cases/ReplaceTaskTemplateItems';
import { InMemoryTaskTemplateRepository } from '../../../infrastructure/adapters/in-memory/InMemoryTaskTemplateRepository';
import { TemplateNotFoundError } from '../../../domain/errors/checklist';

describe('ReplaceTaskTemplateItems', () => {
  let repo: InMemoryTaskTemplateRepository;
  let useCase: ReplaceTaskTemplateItems;
  const TEMPLATE_ID = '1'; // seeded in InMemoryTaskTemplateRepository

  beforeEach(() => {
    repo = new InMemoryTaskTemplateRepository();
    useCase = new ReplaceTaskTemplateItems(repo);
  });

  it('replaces empty template with 3 items (order 0,1,2)', async () => {
    const items = await useCase.execute(TEMPLATE_ID, [
      { text: 'Step A' },
      { text: 'Step B' },
      { text: 'Step C' },
    ]);
    expect(items).toHaveLength(3);
    expect(items[0].order).toBe(0);
    expect(items[0].text).toBe('Step A');
    expect(items[1].order).toBe(1);
    expect(items[2].order).toBe(2);
    expect(items[0].templateId).toBe(TEMPLATE_ID);
  });

  it('replaces 3 items with 2 items (old 3rd deleted)', async () => {
    await useCase.execute(TEMPLATE_ID, [
      { text: 'A' }, { text: 'B' }, { text: 'C' },
    ]);
    const result = await useCase.execute(TEMPLATE_ID, [
      { text: 'X' }, { text: 'Y' },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('X');
    expect(result[1].text).toBe('Y');
  });

  it('throws TemplateNotFoundError for unknown templateId', async () => {
    await expect(useCase.execute('nonexistent', [{ text: 'Item' }]))
      .rejects.toThrow(TemplateNotFoundError);
  });
});
