/**
 * Grouped by entity (tasks.md T3.1): ListNewsCategories, CreateNewsCategory,
 * UpdateNewsCategory, DeleteNewsCategory (NEWS-UC-4 — guardeado in-use).
 */
import { ListNewsCategories } from '@application/use-cases/ListNewsCategories';
import { CreateNewsCategory } from '@application/use-cases/CreateNewsCategory';
import { UpdateNewsCategory } from '@application/use-cases/UpdateNewsCategory';
import { DeleteNewsCategory } from '@application/use-cases/DeleteNewsCategory';
import { InMemoryNewsCategoryRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsCategoryRepository';
import {
  NewsCategoryNotFoundError,
  NewsCategoryNameConflictError,
  NewsCategoryInUseError,
} from '@domain/errors/news';

describe('ListNewsCategories', () => {
  it('devuelve DTOs curados', async () => {
    const repo = new InMemoryNewsCategoryRepository();
    await repo.create({ name: 'General', color: '#64748b' });
    const useCase = new ListNewsCategories(repo);
    const result = await useCase.execute();
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ id: expect.any(String), name: 'General', color: '#64748b' });
  });
});

describe('CreateNewsCategory', () => {
  it('crea una categoría nueva', async () => {
    const repo = new InMemoryNewsCategoryRepository();
    const useCase = new CreateNewsCategory(repo);
    const dto = await useCase.execute({ name: 'Comercial', color: '#10b981' });
    expect(dto.name).toBe('Comercial');
  });

  it('lanza NewsCategoryNameConflictError en nombre duplicado', async () => {
    const repo = new InMemoryNewsCategoryRepository();
    const useCase = new CreateNewsCategory(repo);
    await useCase.execute({ name: 'Comercial', color: '#10b981' });
    await expect(useCase.execute({ name: 'Comercial', color: '#000000' })).rejects.toThrow(
      NewsCategoryNameConflictError,
    );
  });
});

describe('UpdateNewsCategory', () => {
  it('actualiza name/color', async () => {
    const repo = new InMemoryNewsCategoryRepository();
    const cat = await repo.create({ name: 'General', color: '#64748b' });
    const useCase = new UpdateNewsCategory(repo);
    const dto = await useCase.execute(cat.id, { name: 'General 2' });
    expect(dto.name).toBe('General 2');
  });

  it('404 en id inexistente', async () => {
    const repo = new InMemoryNewsCategoryRepository();
    const useCase = new UpdateNewsCategory(repo);
    await expect(useCase.execute('missing', { name: 'X' })).rejects.toThrow(NewsCategoryNotFoundError);
  });

  it('409 en conflicto de nombre contra otra categoría', async () => {
    const repo = new InMemoryNewsCategoryRepository();
    await repo.create({ name: 'Comercial', color: '#10b981' });
    const cat2 = await repo.create({ name: 'General', color: '#64748b' });
    const useCase = new UpdateNewsCategory(repo);
    await expect(useCase.execute(cat2.id, { name: 'Comercial' })).rejects.toThrow(NewsCategoryNameConflictError);
  });
});

describe('DeleteNewsCategory (NEWS-UC-4)', () => {
  it('lanza NewsCategoryInUseError si tiene posts y NO la borra', async () => {
    const repo = new InMemoryNewsCategoryRepository();
    const cat = await repo.create({ name: 'General', color: '#64748b' });
    repo.postCounts[cat.id] = 1;
    const useCase = new DeleteNewsCategory(repo);

    await expect(useCase.execute(cat.id)).rejects.toThrow(NewsCategoryInUseError);
    expect(await repo.findById(cat.id)).not.toBeNull();
  });

  it('borra una categoría vacía', async () => {
    const repo = new InMemoryNewsCategoryRepository();
    const cat = await repo.create({ name: 'Vacía', color: '#000000' });
    const useCase = new DeleteNewsCategory(repo);
    await useCase.execute(cat.id);
    expect(await repo.findById(cat.id)).toBeNull();
  });

  it('404 en id inexistente', async () => {
    const repo = new InMemoryNewsCategoryRepository();
    const useCase = new DeleteNewsCategory(repo);
    await expect(useCase.execute('missing')).rejects.toThrow(NewsCategoryNotFoundError);
  });
});
