import { createScheduledTaskAttachment } from '@domain/entities/scheduledTaskAttachment';

const base = {
  id: 'att-1',
  taskId: 'task-1',
  storageKey: 'tasks/task-1/att-1.jpg',
  filename: 'photo.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: 2048,
  uploadedById: 'user-1',
};

describe('createScheduledTaskAttachment', () => {
  it('builds a valid attachment, defaulting width/height to null and stamping createdAt', () => {
    const att = createScheduledTaskAttachment({ ...base });

    expect(att.width).toBeNull();
    expect(att.height).toBeNull();
    expect(typeof att.createdAt).toBe('string');
    expect(Number.isNaN(Date.parse(att.createdAt))).toBe(false);
    expect(att.id).toBe('att-1');
    expect(att.taskId).toBe('task-1');
    expect(att.storageKey).toBe('tasks/task-1/att-1.jpg');
    expect(att.sizeBytes).toBe(2048);
    expect(att.uploadedById).toBe('user-1');
  });

  it('keeps provided width/height and createdAt', () => {
    const att = createScheduledTaskAttachment({
      ...base,
      width: 800,
      height: 600,
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    expect(att.width).toBe(800);
    expect(att.height).toBe(600);
    expect(att.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('throws when filename is empty', () => {
    expect(() => createScheduledTaskAttachment({ ...base, filename: '   ' })).toThrow();
  });

  it('throws when sizeBytes is not greater than 0', () => {
    expect(() => createScheduledTaskAttachment({ ...base, sizeBytes: 0 })).toThrow();
    expect(() => createScheduledTaskAttachment({ ...base, sizeBytes: -1 })).toThrow();
  });

  it('throws when uploadedById is empty (D3 invariant)', () => {
    expect(() => createScheduledTaskAttachment({ ...base, uploadedById: '' })).toThrow();
    expect(() => createScheduledTaskAttachment({ ...base, uploadedById: '   ' })).toThrow();
  });
});
