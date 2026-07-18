/**
 * N2 — news attachment use cases (in-memory ports only, no Prisma / no MinIO).
 *
 * AttachFilesToNews  → images/files to storage (prefix news/{postId}/), rows created
 * AttachLinkToNews   → link row (no storage), url required
 * GetNewsAttachmentFile → resolves the binary; link/missing → 404
 * DeleteNewsAttachment  → storage + row gone (idempotent storage delete)
 */
import { AttachFilesToNews, MAX_ATTACHMENTS_PER_POST } from '@application/use-cases/AttachFilesToNews';
import { AttachLinkToNews } from '@application/use-cases/AttachLinkToNews';
import { GetNewsAttachmentFile } from '@application/use-cases/GetNewsAttachmentFile';
import { DeleteNewsAttachment } from '@application/use-cases/DeleteNewsAttachment';

import { InMemoryNewsPostAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsPostAttachmentRepository';
import { InMemoryFileStorage } from '@infrastructure/adapters/in-memory/InMemoryFileStorage';
import { InMemoryNewsPostRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsPostRepository';
import { InMemoryNewsCategoryRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsCategoryRepository';

import { NewsPostNotFoundError } from '@domain/errors/news';
import {
  UnsupportedNewsAttachmentTypeError,
  TooManyNewsAttachmentsError,
  NewsAttachmentNotFoundError,
  InvalidLinkAttachmentError,
} from '@domain/errors/newsAttachment';

const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

async function seedPost(): Promise<{ postRepo: InMemoryNewsPostRepository; postId: string }> {
  const categoryRepo = new InMemoryNewsCategoryRepository();
  const postRepo = new InMemoryNewsPostRepository(categoryRepo);
  const cat = await categoryRepo.create({ name: 'General', color: '#64748b' });
  const post = await postRepo.create({ title: 'T', body: 'B', categoryId: cat.id, authorId: 'a', authorName: 'A' });
  return { postRepo, postId: post.id };
}

function build(postRepo: InMemoryNewsPostRepository) {
  const repo = new InMemoryNewsPostAttachmentRepository();
  const storage = new InMemoryFileStorage();
  return {
    repo,
    storage,
    attachFiles: new AttachFilesToNews(repo, storage, postRepo),
    attachLink: new AttachLinkToNews(repo, postRepo),
    getFile: new GetNewsAttachmentFile(repo, storage),
    del: new DeleteNewsAttachment(repo, storage),
  };
}

describe('AttachFilesToNews', () => {
  it('image → row kind image + binary saved under news/{postId}/ prefix', async () => {
    const { postRepo, postId } = await seedPost();
    const { attachFiles, repo, storage } = build(postRepo);

    const dtos = await attachFiles.execute({
      newsPostId: postId,
      uploadedById: 'u1',
      files: [{ buffer: JPG, originalName: 'foto.jpg', mimeType: 'image/jpeg' }],
    });

    expect(dtos).toHaveLength(1);
    expect(dtos[0]!.kind).toBe('image');
    expect(dtos[0]!.fileUrl).toBe(`/api/news/attachments/${dtos[0]!.id}/file`);
    expect(dtos[0]!.url).toBeNull();
    // stored binary key under the news/ prefix, never exposed in the DTO
    const row = await repo.findById(dtos[0]!.id);
    expect(row!.storageKey!.startsWith(`news/${postId}/`)).toBe(true);
    expect(await storage.get(row!.storageKey!)).not.toBeNull();
    expect((dtos[0] as unknown as { storageKey?: string }).storageKey).toBeUndefined();
  });

  it('.md file (any declared mime) → accepted as file/markdown', async () => {
    const { postRepo, postId } = await seedPost();
    const { attachFiles } = build(postRepo);
    const dtos = await attachFiles.execute({
      newsPostId: postId,
      uploadedById: 'u1',
      files: [{ buffer: Buffer.from('# hi'), originalName: 'notas.md', mimeType: 'application/octet-stream' }],
    });
    expect(dtos[0]!.kind).toBe('file');
    expect(dtos[0]!.mimeType).toBe('text/markdown');
  });

  it('pdf → accepted as file', async () => {
    const { postRepo, postId } = await seedPost();
    const { attachFiles } = build(postRepo);
    const dtos = await attachFiles.execute({
      newsPostId: postId,
      uploadedById: 'u1',
      files: [{ buffer: Buffer.from('%PDF-1.4'), originalName: 'doc.pdf', mimeType: 'application/pdf' }],
    });
    expect(dtos[0]!.kind).toBe('file');
  });

  it('unsupported mimetype → UnsupportedNewsAttachmentTypeError, nothing persisted', async () => {
    const { postRepo, postId } = await seedPost();
    const { attachFiles, repo } = build(postRepo);
    await expect(
      attachFiles.execute({
        newsPostId: postId,
        uploadedById: 'u1',
        files: [{ buffer: Buffer.from('x'), originalName: 'a.exe', mimeType: 'application/x-msdownload' }],
      }),
    ).rejects.toBeInstanceOf(UnsupportedNewsAttachmentTypeError);
    expect(await repo.countByNewsPostId(postId)).toBe(0);
  });

  it('0-byte file → rejected', async () => {
    const { postRepo, postId } = await seedPost();
    const { attachFiles } = build(postRepo);
    await expect(
      attachFiles.execute({
        newsPostId: postId,
        uploadedById: 'u1',
        files: [{ buffer: Buffer.alloc(0), originalName: 'a.jpg', mimeType: 'image/jpeg' }],
      }),
    ).rejects.toBeInstanceOf(UnsupportedNewsAttachmentTypeError);
  });

  it('post inexistente → NewsPostNotFoundError', async () => {
    const { postRepo } = await seedPost();
    const { attachFiles } = build(postRepo);
    await expect(
      attachFiles.execute({
        newsPostId: 'ghost',
        uploadedById: 'u1',
        files: [{ buffer: JPG, originalName: 'a.jpg', mimeType: 'image/jpeg' }],
      }),
    ).rejects.toBeInstanceOf(NewsPostNotFoundError);
  });

  it('cupo excedido → TooManyNewsAttachmentsError', async () => {
    const { postRepo, postId } = await seedPost();
    const { attachFiles } = build(postRepo);
    const files = Array.from({ length: MAX_ATTACHMENTS_PER_POST + 1 }, (_, i) => ({
      buffer: JPG,
      originalName: `f${i}.jpg`,
      mimeType: 'image/jpeg',
    }));
    await expect(
      attachFiles.execute({ newsPostId: postId, uploadedById: 'u1', files }),
    ).rejects.toBeInstanceOf(TooManyNewsAttachmentsError);
  });
});

describe('AttachLinkToNews', () => {
  it('link → row kind link, url set, no storageKey, fileUrl null', async () => {
    const { postRepo, postId } = await seedPost();
    const { attachLink, repo } = build(postRepo);
    const dto = await attachLink.execute({
      newsPostId: postId,
      uploadedById: 'u1',
      url: 'https://status.example.com',
      filename: 'Estado de red',
    });
    expect(dto.kind).toBe('link');
    expect(dto.url).toBe('https://status.example.com');
    expect(dto.fileUrl).toBeNull();
    expect(dto.filename).toBe('Estado de red');
    const row = await repo.findById(dto.id);
    expect(row!.storageKey).toBeNull();
  });

  it('url no http(s) → InvalidLinkAttachmentError', async () => {
    const { postRepo, postId } = await seedPost();
    const { attachLink } = build(postRepo);
    await expect(
      attachLink.execute({ newsPostId: postId, uploadedById: 'u1', url: 'javascript:alert(1)' }),
    ).rejects.toBeInstanceOf(InvalidLinkAttachmentError);
  });

  it('url vacía → InvalidLinkAttachmentError', async () => {
    const { postRepo, postId } = await seedPost();
    const { attachLink } = build(postRepo);
    await expect(
      attachLink.execute({ newsPostId: postId, uploadedById: 'u1', url: '   ' }),
    ).rejects.toBeInstanceOf(InvalidLinkAttachmentError);
  });

  it('post inexistente → NewsPostNotFoundError', async () => {
    const { postRepo } = await seedPost();
    const { attachLink } = build(postRepo);
    await expect(
      attachLink.execute({ newsPostId: 'ghost', uploadedById: 'u1', url: 'https://x.com' }),
    ).rejects.toBeInstanceOf(NewsPostNotFoundError);
  });
});

describe('GetNewsAttachmentFile', () => {
  it('binary → devuelve buffer + mimeType + filename', async () => {
    const { postRepo, postId } = await seedPost();
    const { attachFiles, getFile } = build(postRepo);
    const [dto] = await attachFiles.execute({
      newsPostId: postId,
      uploadedById: 'u1',
      files: [{ buffer: JPG, originalName: 'foto.jpg', mimeType: 'image/jpeg' }],
    });
    const file = await getFile.execute({ attachmentId: dto!.id });
    expect(file.mimeType).toBe('image/jpeg');
    expect(file.filename).toBe('foto.jpg');
    expect(Buffer.isBuffer(file.buffer)).toBe(true);
  });

  it('link (sin binario) → NewsAttachmentNotFoundError', async () => {
    const { postRepo, postId } = await seedPost();
    const { attachLink, getFile } = build(postRepo);
    const dto = await attachLink.execute({ newsPostId: postId, uploadedById: 'u1', url: 'https://x.com' });
    await expect(getFile.execute({ attachmentId: dto.id })).rejects.toBeInstanceOf(NewsAttachmentNotFoundError);
  });

  it('id inexistente → NewsAttachmentNotFoundError', async () => {
    const { postRepo } = await seedPost();
    const { getFile } = build(postRepo);
    await expect(getFile.execute({ attachmentId: 'ghost' })).rejects.toBeInstanceOf(NewsAttachmentNotFoundError);
  });
});

describe('DeleteNewsAttachment', () => {
  it('borra binario + fila', async () => {
    const { postRepo, postId } = await seedPost();
    const { attachFiles, del, repo, storage } = build(postRepo);
    const [dto] = await attachFiles.execute({
      newsPostId: postId,
      uploadedById: 'u1',
      files: [{ buffer: JPG, originalName: 'foto.jpg', mimeType: 'image/jpeg' }],
    });
    const key = (await repo.findById(dto!.id))!.storageKey!;
    await del.execute({ attachmentId: dto!.id });
    expect(await repo.findById(dto!.id)).toBeNull();
    expect(await storage.get(key)).toBeNull();
  });

  it('link → borra solo la fila (no toca storage)', async () => {
    const { postRepo, postId } = await seedPost();
    const { attachLink, del, repo } = build(postRepo);
    const dto = await attachLink.execute({ newsPostId: postId, uploadedById: 'u1', url: 'https://x.com' });
    await del.execute({ attachmentId: dto.id });
    expect(await repo.findById(dto.id)).toBeNull();
  });

  it('id inexistente → NewsAttachmentNotFoundError', async () => {
    const { postRepo } = await seedPost();
    const { del } = build(postRepo);
    await expect(del.execute({ attachmentId: 'ghost' })).rejects.toBeInstanceOf(NewsAttachmentNotFoundError);
  });
});
