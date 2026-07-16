import { MarkNewsRead } from '@application/use-cases/MarkNewsRead';
import { InMemoryNewsPostRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsPostRepository';
import { InMemoryNewsCategoryRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsCategoryRepository';
import { NewsPostNotFoundError } from '@domain/errors/news';

describe('MarkNewsRead', () => {
  it('es idempotente: dos ejecuciones no fallan y dejan el post leído', async () => {
    const categoryRepo = new InMemoryNewsCategoryRepository();
    const postRepo = new InMemoryNewsPostRepository(categoryRepo);
    const category = await categoryRepo.create({ name: 'General', color: '#64748b' });
    const post = await postRepo.create({ title: 'T', body: 'B', categoryId: category.id, authorId: 'a', authorName: 'A' });

    const useCase = new MarkNewsRead(postRepo);
    await useCase.execute(post.id, 'u1');
    await useCase.execute(post.id, 'u1');

    expect((await postRepo.findById(post.id, 'u1'))!.read).toBe(true);
    expect(postRepo.receipts.size).toBe(1);
  });

  it('lanza NewsPostNotFoundError si el post no existe (404)', async () => {
    const postRepo = new InMemoryNewsPostRepository();
    const useCase = new MarkNewsRead(postRepo);
    await expect(useCase.execute('missing', 'u1')).rejects.toThrow(NewsPostNotFoundError);
  });
});
