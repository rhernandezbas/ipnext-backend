/**
 * N2 — GetNewsPost / ListNewsPosts must EXPOSE the post's attachments in the DTO
 * (id, kind, filename, url for links, fileUrl for binaries). storageKey never leaks.
 */
import { GetNewsPost } from '@application/use-cases/GetNewsPost';
import { ListNewsPosts } from '@application/use-cases/ListNewsPosts';
import { AttachFilesToNews } from '@application/use-cases/AttachFilesToNews';
import { AttachLinkToNews } from '@application/use-cases/AttachLinkToNews';

import { InMemoryNewsPostRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsPostRepository';
import { InMemoryNewsCategoryRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsCategoryRepository';
import { InMemoryNewsPostAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsPostAttachmentRepository';
import { InMemoryFileStorage } from '@infrastructure/adapters/in-memory/InMemoryFileStorage';

const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

async function setup() {
  const categoryRepo = new InMemoryNewsCategoryRepository();
  const postRepo = new InMemoryNewsPostRepository(categoryRepo);
  const attachmentRepo = new InMemoryNewsPostAttachmentRepository();
  const storage = new InMemoryFileStorage();
  const cat = await categoryRepo.create({ name: 'General', color: '#64748b' });
  const post = await postRepo.create({ title: 'T', body: 'B', categoryId: cat.id, authorId: 'a', authorName: 'A' });

  const attachFiles = new AttachFilesToNews(attachmentRepo, storage, postRepo);
  const attachLink = new AttachLinkToNews(attachmentRepo, postRepo);
  await attachFiles.execute({
    newsPostId: post.id,
    uploadedById: 'u1',
    files: [{ buffer: JPG, originalName: 'foto.jpg', mimeType: 'image/jpeg' }],
  });
  await attachLink.execute({ newsPostId: post.id, uploadedById: 'u1', url: 'https://x.com', filename: 'Panel' });

  return { postRepo, attachmentRepo, postId: post.id };
}

describe('GetNewsPost exposes attachments', () => {
  it('detail DTO carries the binary + link attachments', async () => {
    const { postRepo, attachmentRepo, postId } = await setup();
    const uc = new GetNewsPost(postRepo, attachmentRepo);
    const dto = await uc.execute(postId, 'u1');

    expect(dto.attachments).toHaveLength(2);
    const link = dto.attachments.find((a) => a.kind === 'link')!;
    const image = dto.attachments.find((a) => a.kind === 'image')!;
    expect(link.url).toBe('https://x.com');
    expect(link.fileUrl).toBeNull();
    expect(image.url).toBeNull();
    expect(image.fileUrl).toBe(`/api/news/attachments/${image.id}/file`);
    // storageKey never leaks
    expect((image as unknown as { storageKey?: string }).storageKey).toBeUndefined();
    // lastBroadcastAt exposed (null until broadcast)
    expect(dto.lastBroadcastAt).toBeNull();
  });
});

describe('ListNewsPosts exposes attachments per item', () => {
  it('each item carries its own attachments', async () => {
    const { postRepo, attachmentRepo, postId } = await setup();
    const uc = new ListNewsPosts(postRepo, attachmentRepo);
    const result = await uc.execute({}, 'u1');

    const item = result.items.find((i) => i.id === postId)!;
    expect(item.attachments).toHaveLength(2);
  });
});
