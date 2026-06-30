import { InMemoryTaskAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskAttachmentRepository';
import { createScheduledTaskAttachment } from '@domain/entities/scheduledTaskAttachment';

function makeAttachment(over: Partial<Parameters<typeof createScheduledTaskAttachment>[0]> = {}) {
  return createScheduledTaskAttachment({
    id: over.id ?? 'att-1',
    taskId: over.taskId ?? 'task-1',
    storageKey: over.storageKey ?? 'tasks/task-1/att-1.jpg',
    filename: over.filename ?? 'photo.jpg',
    mimeType: over.mimeType ?? 'image/jpeg',
    sizeBytes: over.sizeBytes ?? 1024,
    width: over.width,
    height: over.height,
    uploadedById: over.uploadedById ?? 'user-1',
    createdAt: over.createdAt,
  });
}

describe('InMemoryTaskAttachmentRepository', () => {
  it('create → findById returns the stored attachment', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    const att = makeAttachment({ id: 'att-1' });

    const created = await repo.create(att);
    const found = await repo.findById('att-1');

    expect(created).toEqual(att);
    expect(found).toEqual(att);
  });

  it('findById of an unknown id returns null', async () => {
    const repo = new InMemoryTaskAttachmentRepository();

    expect(await repo.findById('nope')).toBeNull();
  });

  it('findByTaskId returns only the attachments of that task', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    await repo.create(makeAttachment({ id: 'a1', taskId: 'task-1' }));
    await repo.create(makeAttachment({ id: 'a2', taskId: 'task-1' }));
    await repo.create(makeAttachment({ id: 'b1', taskId: 'task-2' }));

    const forTask1 = await repo.findByTaskId('task-1');

    expect(forTask1.map((a) => a.id).sort()).toEqual(['a1', 'a2']);
  });

  it('countByTaskId counts only the attachments of that task', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    await repo.create(makeAttachment({ id: 'a1', taskId: 'task-1' }));
    await repo.create(makeAttachment({ id: 'a2', taskId: 'task-1' }));
    await repo.create(makeAttachment({ id: 'b1', taskId: 'task-2' }));

    expect(await repo.countByTaskId('task-1')).toBe(2);
    expect(await repo.countByTaskId('task-2')).toBe(1);
    expect(await repo.countByTaskId('task-empty')).toBe(0);
  });

  it('delete removes the attachment (and is idempotent)', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    await repo.create(makeAttachment({ id: 'a1', taskId: 'task-1' }));

    await repo.delete('a1');
    expect(await repo.findById('a1')).toBeNull();
    await expect(repo.delete('a1')).resolves.toBeUndefined();
    expect(await repo.countByTaskId('task-1')).toBe(0);
  });
});
