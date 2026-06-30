import { ListTaskAttachments } from '@application/use-cases/ListTaskAttachments';
import { GetTaskAttachmentFile } from '@application/use-cases/GetTaskAttachmentFile';
import { DeleteTaskAttachment } from '@application/use-cases/DeleteTaskAttachment';
import { InMemoryFileStorage } from '@infrastructure/adapters/in-memory/InMemoryFileStorage';
import { InMemoryTaskAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskAttachmentRepository';
import { createScheduledTaskAttachment } from '@domain/entities/scheduledTaskAttachment';
import { AttachmentNotFoundError } from '@domain/errors/taskAttachment';

const KEY = 'tasks/t1/abc.jpg';
const THUMB_KEY = 'tasks/t1/abc.jpg.thumb.jpg';

function seedRow(repo: InMemoryTaskAttachmentRepository, id: string, taskId = 't1', storageKey = KEY) {
  return repo.create(
    createScheduledTaskAttachment({
      id,
      taskId,
      storageKey,
      filename: 'foto.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 100,
      width: 800,
      height: 600,
      uploadedById: 'u1',
    }),
  );
}

describe('ListTaskAttachments', () => {
  it('devuelve DTOs (con fileUrl/thumbUrl, sin storageKey)', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    await seedRow(repo, 'a1');
    await seedRow(repo, 'a2', 't1', 'tasks/t1/def.jpg');

    const dtos = await new ListTaskAttachments(repo).execute({ taskId: 't1' });

    expect(dtos).toHaveLength(2);
    for (const dto of dtos) {
      expect(dto.fileUrl).toBe(`/api/scheduling/attachments/${dto.id}/file`);
      expect((dto as unknown as Record<string, unknown>)['storageKey']).toBeUndefined();
    }
  });

  it('tarea sin adjuntos → []', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    expect(await new ListTaskAttachments(repo).execute({ taskId: 'empty' })).toEqual([]);
  });
});

describe('GetTaskAttachmentFile', () => {
  it('variant original → binario original', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    const storage = new InMemoryFileStorage();
    await seedRow(repo, 'a1');
    await storage.save({ key: KEY, buffer: Buffer.from('ORIGINAL'), mimeType: 'image/jpeg' });

    const file = await new GetTaskAttachmentFile(repo, storage).execute({ attachmentId: 'a1', variant: 'original' });

    expect(file.buffer.toString()).toBe('ORIGINAL');
    expect(file.mimeType).toBe('image/jpeg');
    expect(file.filename).toBe('foto.jpg');
  });

  it('variant thumb → binario del thumbnail', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    const storage = new InMemoryFileStorage();
    await seedRow(repo, 'a1');
    await storage.save({ key: KEY, buffer: Buffer.from('ORIGINAL'), mimeType: 'image/jpeg' });
    await storage.save({ key: THUMB_KEY, buffer: Buffer.from('THUMB'), mimeType: 'image/jpeg' });

    const file = await new GetTaskAttachmentFile(repo, storage).execute({ attachmentId: 'a1', variant: 'thumb' });

    expect(file.buffer.toString()).toBe('THUMB');
  });

  it('variant thumb sin thumb (foto vieja) → cae al original', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    const storage = new InMemoryFileStorage();
    await seedRow(repo, 'a1');
    await storage.save({ key: KEY, buffer: Buffer.from('ORIGINAL'), mimeType: 'image/jpeg' });
    // NO se guarda el thumb

    const file = await new GetTaskAttachmentFile(repo, storage).execute({ attachmentId: 'a1', variant: 'thumb' });

    expect(file.buffer.toString()).toBe('ORIGINAL');
  });

  it('adjunto inexistente → AttachmentNotFoundError', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    const storage = new InMemoryFileStorage();
    await expect(
      new GetTaskAttachmentFile(repo, storage).execute({ attachmentId: 'ghost', variant: 'original' }),
    ).rejects.toBeInstanceOf(AttachmentNotFoundError);
  });
});

describe('DeleteTaskAttachment', () => {
  it('borra original + thumb del storage y la fila (idempotente)', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    const storage = new InMemoryFileStorage();
    await seedRow(repo, 'a1');
    await storage.save({ key: KEY, buffer: Buffer.from('ORIGINAL'), mimeType: 'image/jpeg' });
    await storage.save({ key: THUMB_KEY, buffer: Buffer.from('THUMB'), mimeType: 'image/jpeg' });

    await new DeleteTaskAttachment(repo, storage).execute({ attachmentId: 'a1' });

    expect(storage.store.size).toBe(0);
    expect(await repo.findById('a1')).toBeNull();
  });

  it('sin thumb en el storage → igual borra el original y la fila (delete idempotente)', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    const storage = new InMemoryFileStorage();
    await seedRow(repo, 'a1');
    await storage.save({ key: KEY, buffer: Buffer.from('ORIGINAL'), mimeType: 'image/jpeg' });

    await new DeleteTaskAttachment(repo, storage).execute({ attachmentId: 'a1' });

    expect(storage.store.has(KEY)).toBe(false);
    expect(await repo.findById('a1')).toBeNull();
  });

  it('adjunto inexistente → AttachmentNotFoundError', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    const storage = new InMemoryFileStorage();
    await expect(
      new DeleteTaskAttachment(repo, storage).execute({ attachmentId: 'ghost' }),
    ).rejects.toBeInstanceOf(AttachmentNotFoundError);
  });
});
