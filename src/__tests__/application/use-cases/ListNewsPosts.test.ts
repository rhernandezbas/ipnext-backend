import { ListNewsPosts } from '@application/use-cases/ListNewsPosts';
import { InMemoryNewsPostRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsPostRepository';
import { InMemoryNewsCategoryRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsCategoryRepository';

describe('ListNewsPosts (NEWS-UC-2)', () => {
  it('unreadCount es GLOBAL (no lo achica el filtro de categoría aplicado a items)', async () => {
    const categoryRepo = new InMemoryNewsCategoryRepository();
    const postRepo = new InMemoryNewsPostRepository(categoryRepo);
    const catX = await categoryRepo.create({ name: 'X', color: '#111111' });
    const catY = await categoryRepo.create({ name: 'Y', color: '#222222' });

    await postRepo.create({ title: 'P1', body: 'b', categoryId: catX.id, authorId: 'a', authorName: 'A' });
    await postRepo.create({ title: 'P2', body: 'b', categoryId: catX.id, authorId: 'a', authorName: 'A' });
    await postRepo.create({ title: 'P3', body: 'b', categoryId: catY.id, authorId: 'a', authorName: 'A' });

    const useCase = new ListNewsPosts(postRepo);
    const result = await useCase.execute({ categoryId: catX.id }, 'u1');

    expect(result.items).toHaveLength(2);
    expect(result.unreadCount).toBe(3);
  });

  it('devuelve items vacíos + unreadCount 0 cuando no hay posts', async () => {
    const postRepo = new InMemoryNewsPostRepository();
    const useCase = new ListNewsPosts(postRepo);
    const result = await useCase.execute({}, 'u1');
    expect(result.items).toEqual([]);
    expect(result.unreadCount).toBe(0);
  });
});
