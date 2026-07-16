import { GetNewsPost } from '@application/use-cases/GetNewsPost';
import { InMemoryNewsPostRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsPostRepository';
import { InMemoryNewsCategoryRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsCategoryRepository';
import { NewsPostNotFoundError } from '@domain/errors/news';

describe('GetNewsPost', () => {
  it('devuelve el detalle con read state y NO marca leído automáticamente', async () => {
    const categoryRepo = new InMemoryNewsCategoryRepository();
    const postRepo = new InMemoryNewsPostRepository(categoryRepo);
    const category = await categoryRepo.create({ name: 'General', color: '#64748b' });
    const post = await postRepo.create({ title: 'T', body: 'B', categoryId: category.id, authorId: 'a', authorName: 'A' });

    const useCase = new GetNewsPost(postRepo);
    const dto = await useCase.execute(post.id, 'u1');

    expect(dto.id).toBe(post.id);
    expect(dto.read).toBe(false);

    // NO auto-marca: countUnread debe seguir contando este post para u1
    expect(await postRepo.countUnread('u1')).toBe(1);
  });

  it('lanza NewsPostNotFoundError para id inexistente (404)', async () => {
    const postRepo = new InMemoryNewsPostRepository();
    const useCase = new GetNewsPost(postRepo);
    await expect(useCase.execute('missing', 'u1')).rejects.toThrow(NewsPostNotFoundError);
  });
});
