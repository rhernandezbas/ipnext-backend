import { UpdateNewsPost } from '@application/use-cases/UpdateNewsPost';
import { InMemoryNewsPostRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsPostRepository';
import { InMemoryNewsCategoryRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsCategoryRepository';
import { NewsPostNotFoundError, NewsCategoryNotFoundError } from '@domain/errors/news';

describe('UpdateNewsPost', () => {
  it('aplica un patch parcial (title/body/pinned)', async () => {
    const categoryRepo = new InMemoryNewsCategoryRepository();
    const postRepo = new InMemoryNewsPostRepository(categoryRepo);
    const category = await categoryRepo.create({ name: 'General', color: '#64748b' });
    const post = await postRepo.create({ title: 'Old', body: 'B', categoryId: category.id, authorId: 'a', authorName: 'A' });

    const useCase = new UpdateNewsPost(postRepo, categoryRepo);
    const dto = await useCase.execute(post.id, { title: 'New', pinned: true });

    expect(dto.title).toBe('New');
    expect(dto.pinned).toBe(true);
    expect(dto.body).toBe('B');
  });

  it('422 (dominio): categoría inexistente en el patch', async () => {
    const categoryRepo = new InMemoryNewsCategoryRepository();
    const postRepo = new InMemoryNewsPostRepository(categoryRepo);
    const category = await categoryRepo.create({ name: 'General', color: '#64748b' });
    const post = await postRepo.create({ title: 'Old', body: 'B', categoryId: category.id, authorId: 'a', authorName: 'A' });

    const useCase = new UpdateNewsPost(postRepo, categoryRepo);
    await expect(useCase.execute(post.id, { categoryId: 'nope' })).rejects.toThrow(NewsCategoryNotFoundError);
  });

  it('404: post inexistente', async () => {
    const categoryRepo = new InMemoryNewsCategoryRepository();
    const postRepo = new InMemoryNewsPostRepository(categoryRepo);
    const useCase = new UpdateNewsPost(postRepo, categoryRepo);
    await expect(useCase.execute('missing', { title: 'X' })).rejects.toThrow(NewsPostNotFoundError);
  });
});
