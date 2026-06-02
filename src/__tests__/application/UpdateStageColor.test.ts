import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { UpdateStageColor } from '@application/use-cases/UpdateStageColor';
import { StageNotFoundError } from '@domain/errors/scheduling';

describe('UpdateStageColor', () => {
  it('updates the colour of an existing stage', async () => {
    const repo = new InMemoryStageRepository();
    const stage = await repo.add('wf-1', { name: 'Nuevo', code: 'nuevo', category: 'nuevo', order: 0 });
    const uc = new UpdateStageColor(repo);

    const updated = await uc.execute(stage.id, '#ff8800');
    expect(updated.color).toBe('#ff8800');
    expect((await repo.getById(stage.id))?.color).toBe('#ff8800');
  });

  it('throws StageNotFoundError for an unknown stage', async () => {
    const repo = new InMemoryStageRepository();
    const uc = new UpdateStageColor(repo);
    await expect(uc.execute('nope', '#000')).rejects.toBeInstanceOf(StageNotFoundError);
  });
});
