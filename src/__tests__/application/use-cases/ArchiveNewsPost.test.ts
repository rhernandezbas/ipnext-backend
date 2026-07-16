import { ArchiveNewsPost } from '@application/use-cases/ArchiveNewsPost';
import { InMemoryNewsPostRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsPostRepository';
import { InMemoryNewsCategoryRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsCategoryRepository';
import { NewsPostNotFoundError } from '@domain/errors/news';

describe('ArchiveNewsPost (NEWS-UC-3)', () => {
  it('archiva y desarchiva (archivedAt pasa a fecha y vuelve a null)', async () => {
    const categoryRepo = new InMemoryNewsCategoryRepository();
    const postRepo = new InMemoryNewsPostRepository(categoryRepo);
    const category = await categoryRepo.create({ name: 'General', color: '#64748b' });
    const post = await postRepo.create({ title: 'T', body: 'B', categoryId: category.id, authorId: 'a', authorName: 'A' });

    const useCase = new ArchiveNewsPost(postRepo);
    const archived = await useCase.execute(post.id, true);
    expect(archived.archivedAt).toBeTruthy();

    const restored = await useCase.execute(post.id, false);
    expect(restored.archivedAt).toBeNull();
  });

  it('lanza NewsPostNotFoundError para id inexistente', async () => {
    const postRepo = new InMemoryNewsPostRepository();
    const useCase = new ArchiveNewsPost(postRepo);
    await expect(useCase.execute('missing', true)).rejects.toThrow(NewsPostNotFoundError);
  });
});
