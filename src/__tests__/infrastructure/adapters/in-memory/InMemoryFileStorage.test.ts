import { InMemoryFileStorage } from '@infrastructure/adapters/in-memory/InMemoryFileStorage';

describe('InMemoryFileStorage', () => {
  it('save → get round-trips the buffer and mimeType', async () => {
    const storage = new InMemoryFileStorage();
    const buffer = Buffer.from('hello world');

    await storage.save({ key: 'tasks/t1/photo.jpg', buffer, mimeType: 'image/jpeg' });
    const stored = await storage.get('tasks/t1/photo.jpg');

    expect(stored).not.toBeNull();
    expect(stored!.mimeType).toBe('image/jpeg');
    expect(stored!.buffer.equals(buffer)).toBe(true);
  });

  it('get of an unknown key returns null', async () => {
    const storage = new InMemoryFileStorage();

    const stored = await storage.get('tasks/missing/none.jpg');

    expect(stored).toBeNull();
  });

  it('delete is idempotent — deleting twice does not throw', async () => {
    const storage = new InMemoryFileStorage();
    await storage.save({ key: 'k', buffer: Buffer.from('x'), mimeType: 'image/png' });

    await storage.delete('k');
    await expect(storage.delete('k')).resolves.toBeUndefined();
    expect(await storage.get('k')).toBeNull();
  });

  it('overwriting the same key replaces the previous content', async () => {
    const storage = new InMemoryFileStorage();
    await storage.save({ key: 'k', buffer: Buffer.from('first'), mimeType: 'image/png' });

    await storage.save({ key: 'k', buffer: Buffer.from('second'), mimeType: 'image/jpeg' });
    const stored = await storage.get('k');

    expect(stored!.mimeType).toBe('image/jpeg');
    expect(stored!.buffer.toString()).toBe('second');
  });
});
