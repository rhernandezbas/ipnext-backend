import { createNewsPostAttachment } from '@domain/entities/newsPostAttachment';

/**
 * N2 — factory invariants of NewsPostAttachment.
 *
 * Two shapes behind one entity:
 *  - binary (kind 'image'|'file'): storageKey + filename + mimeType + sizeBytes>0, url null
 *  - link   (kind 'link'):         url required, storageKey/mimeType/sizeBytes null, filename optional
 */
describe('createNewsPostAttachment', () => {
  it('image → keeps storageKey, url null, defaults createdAt', () => {
    const a = createNewsPostAttachment({
      id: '1',
      newsPostId: 'p1',
      kind: 'image',
      storageKey: 'news/p1/1.jpg',
      filename: 'foto.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 1234,
      uploadedById: 'u1',
    });
    expect(a.kind).toBe('image');
    expect(a.storageKey).toBe('news/p1/1.jpg');
    expect(a.url).toBeNull();
    expect(a.filename).toBe('foto.jpg');
    expect(a.sizeBytes).toBe(1234);
    expect(typeof a.createdAt).toBe('string');
  });

  it('file (markdown) → binary shape', () => {
    const a = createNewsPostAttachment({
      id: '2',
      newsPostId: 'p1',
      kind: 'file',
      storageKey: 'news/p1/2.md',
      filename: 'notas.md',
      mimeType: 'text/markdown',
      sizeBytes: 50,
      uploadedById: 'u1',
    });
    expect(a.kind).toBe('file');
    expect(a.url).toBeNull();
  });

  it('link → url required; storageKey/mimeType/sizeBytes null; filename optional → null', () => {
    const a = createNewsPostAttachment({
      id: '3',
      newsPostId: 'p1',
      kind: 'link',
      url: 'https://status.example.com',
      uploadedById: 'u1',
    });
    expect(a.kind).toBe('link');
    expect(a.url).toBe('https://status.example.com');
    expect(a.storageKey).toBeNull();
    expect(a.mimeType).toBeNull();
    expect(a.sizeBytes).toBeNull();
    expect(a.filename).toBeNull();
  });

  it('link with filename → trimmed label kept', () => {
    const a = createNewsPostAttachment({
      id: '4',
      newsPostId: 'p1',
      kind: 'link',
      url: 'https://x.com',
      filename: '  Panel  ',
      uploadedById: 'u1',
    });
    expect(a.filename).toBe('Panel');
  });

  it('link without url → throws', () => {
    expect(() =>
      createNewsPostAttachment({
        id: '5',
        newsPostId: 'p1',
        kind: 'link',
        uploadedById: 'u1',
      } as never),
    ).toThrow();
  });

  it('binary without storageKey → throws', () => {
    expect(() =>
      createNewsPostAttachment({
        id: '6',
        newsPostId: 'p1',
        kind: 'image',
        filename: 'a.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 10,
        uploadedById: 'u1',
      } as never),
    ).toThrow();
  });

  it('binary with sizeBytes 0 → throws', () => {
    expect(() =>
      createNewsPostAttachment({
        id: '7',
        newsPostId: 'p1',
        kind: 'file',
        storageKey: 'news/p1/7.pdf',
        filename: 'a.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 0,
        uploadedById: 'u1',
      }),
    ).toThrow();
  });

  it('missing uploadedById → throws', () => {
    expect(() =>
      createNewsPostAttachment({
        id: '8',
        newsPostId: 'p1',
        kind: 'link',
        url: 'https://x.com',
        uploadedById: '',
      }),
    ).toThrow();
  });
});
