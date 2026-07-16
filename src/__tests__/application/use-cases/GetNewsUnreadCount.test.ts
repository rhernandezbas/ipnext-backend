import { GetNewsUnreadCount } from '@application/use-cases/GetNewsUnreadCount';
import { InMemoryNewsPostRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsPostRepository';
import { InMemoryNewsCategoryRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsCategoryRepository';

describe('GetNewsUnreadCount', () => {
  it('delega en NewsPostRepository.countUnread', async () => {
    const categoryRepo = new InMemoryNewsCategoryRepository();
    const postRepo = new InMemoryNewsPostRepository(categoryRepo);
    const category = await categoryRepo.create({ name: 'General', color: '#64748b' });
    await postRepo.create({ title: 'T1', body: 'B', categoryId: category.id, authorId: 'a', authorName: 'A' });
    const p2 = await postRepo.create({ title: 'T2', body: 'B', categoryId: category.id, authorId: 'a', authorName: 'A' });
    await postRepo.markRead(p2.id, 'u1');

    const useCase = new GetNewsUnreadCount(postRepo);
    expect(await useCase.execute('u1')).toBe(1);
  });
});
