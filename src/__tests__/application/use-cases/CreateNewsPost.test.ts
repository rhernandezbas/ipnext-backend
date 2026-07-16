import { CreateNewsPost } from '@application/use-cases/CreateNewsPost';
import { InMemoryNewsPostRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsPostRepository';
import { InMemoryNewsCategoryRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsCategoryRepository';
import { NewsCategoryNotFoundError } from '@domain/errors/news';

describe('CreateNewsPost', () => {
  it('estampa autor + publishedAt, valida categoría y devuelve un DTO curado (NEWS-UC-1)', async () => {
    const categoryRepo = new InMemoryNewsCategoryRepository();
    const postRepo = new InMemoryNewsPostRepository(categoryRepo);
    const category = await categoryRepo.create({ name: 'General', color: '#64748b' });
    const useCase = new CreateNewsPost(postRepo, categoryRepo);

    const dto = await useCase.execute({
      title: 'Novedad',
      body: 'Detalle',
      categoryId: category.id,
      pinned: true,
      authorId: 'u1',
      authorName: 'Ana',
    });

    expect(dto.authorId).toBe('u1');
    expect(dto.authorName).toBe('Ana');
    expect(dto.pinned).toBe(true);
    expect(dto.read).toBe(false);
    expect(dto.publishedAt).toBeTruthy();
    expect(dto.category.id).toBe(category.id);
    // never a raw Prisma entity — curated DTO only
    expect(dto).not.toHaveProperty('categoryId');
  });

  it('lanza NewsCategoryNotFoundError cuando la categoría no existe', async () => {
    const categoryRepo = new InMemoryNewsCategoryRepository();
    const postRepo = new InMemoryNewsPostRepository(categoryRepo);
    const useCase = new CreateNewsPost(postRepo, categoryRepo);

    await expect(
      useCase.execute({
        title: 'Novedad',
        body: 'Detalle',
        categoryId: 'nope',
        authorId: 'u1',
        authorName: 'Ana',
      }),
    ).rejects.toThrow(NewsCategoryNotFoundError);
  });

  it('permite authorId null (sesión sin usuario resoluble) preservando authorName', async () => {
    const categoryRepo = new InMemoryNewsCategoryRepository();
    const postRepo = new InMemoryNewsPostRepository(categoryRepo);
    const category = await categoryRepo.create({ name: 'General', color: '#64748b' });
    const useCase = new CreateNewsPost(postRepo, categoryRepo);

    const dto = await useCase.execute({
      title: 'Novedad',
      body: 'Detalle',
      categoryId: category.id,
      authorId: null,
      authorName: 'Sistema',
    });

    expect(dto.authorId).toBeNull();
    expect(dto.authorName).toBe('Sistema');
  });
});
