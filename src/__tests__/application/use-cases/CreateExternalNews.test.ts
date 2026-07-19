/**
 * external-news — CreateExternalNews orchestrates the 2nd external WRITE. Tests the
 * full seam with in-memory ports (NO mocking use cases — CLAUDE.md rule): category
 * resolved BY NAME, all-or-nothing on the 4xx path (bad/too-many links → throw BEFORE
 * creating the post), and best-effort WhatsApp broadcast (known nocBroadcast errors
 * do NOT propagate — they surface as { requested, sent:false, error:<code> }).
 */
import { CreateExternalNews } from '@application/use-cases/CreateExternalNews';
import { CreateNewsPost } from '@application/use-cases/CreateNewsPost';
import { AttachLinkToNews } from '@application/use-cases/AttachLinkToNews';
import { AttachFilesToNews } from '@application/use-cases/AttachFilesToNews';
import { BroadcastNewsToNoc } from '@application/use-cases/BroadcastNewsToNoc';
import { BroadcastToNoc } from '@application/use-cases/nocBroadcast/BroadcastToNoc';
import { InMemoryNewsPostRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsPostRepository';
import { InMemoryNewsCategoryRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsCategoryRepository';
import { InMemoryNewsPostAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsPostAttachmentRepository';
import { InMemoryFileStorage } from '@infrastructure/adapters/in-memory/InMemoryFileStorage';
import { InMemoryNocBroadcastConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryNocBroadcastConfigRepository';
import { FileStorage, StoredFile } from '@domain/ports/FileStorage';
import { NocBroadcastGateway } from '@domain/ports/NocBroadcastGateway';
import { NewsCategoryNotFoundError } from '@domain/errors/news';
import {
  InvalidLinkAttachmentError,
  TooManyNewsAttachmentsError,
  UnsupportedNewsAttachmentTypeError,
} from '@domain/errors/newsAttachment';
import {
  NocBroadcastNotConfiguredError,
  EvolutionApiError,
} from '@domain/errors/nocBroadcast';

class FakeGateway implements NocBroadcastGateway {
  sent: string[] = [];
  error: Error | null = null;
  async sendText(text: string): Promise<void> {
    if (this.error) throw this.error;
    this.sent.push(text);
  }
}

const AUTHOR = { authorId: 'api-1', authorName: 'Api' };

/** FileStorage that ALWAYS fails on save (simula caída de MinIO/infra en el paso 4b). */
class FailingFileStorage implements FileStorage {
  async save(): Promise<void> {
    throw new Error('storage down');
  }
  async get(): Promise<StoredFile | null> {
    return null;
  }
  async delete(): Promise<void> {
    /* no-op — la compensación de AttachFilesToNews la llama y no debe romper */
  }
}

async function build(
  appPublicUrl = 'http://panel.local',
  storage: FileStorage = new InMemoryFileStorage(),
) {
  const categoryRepo = new InMemoryNewsCategoryRepository();
  const postRepo = new InMemoryNewsPostRepository(categoryRepo);
  const attachmentRepo = new InMemoryNewsPostAttachmentRepository();
  const config = new InMemoryNocBroadcastConfigRepository();
  await config.update({ appPublicUrl });
  const gateway = new FakeGateway();

  const uc = new CreateExternalNews(
    categoryRepo,
    new CreateNewsPost(postRepo, categoryRepo),
    new AttachLinkToNews(attachmentRepo, postRepo),
    new BroadcastNewsToNoc(postRepo, new BroadcastToNoc(config, gateway)),
    new AttachFilesToNews(attachmentRepo, storage, postRepo),
    postRepo,
  );
  return { uc, categoryRepo, postRepo, attachmentRepo, storage, gateway };
}

const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

const base = {
  title: 'Corte programado',
  body: 'Detalle **markdown**',
  ...AUTHOR,
};

describe('CreateExternalNews', () => {
  it('creación ok — post con categoría resuelta por NOMBRE, sin links, sin whatsapp', async () => {
    const { uc, categoryRepo, gateway } = await build();
    await categoryRepo.create({ name: 'General', color: '#64748b' });

    const result = await uc.execute({ ...base, category: 'General', pinned: true });

    expect(result.post.title).toBe('Corte programado');
    expect(result.post.pinned).toBe(true);
    expect(result.post.category.name).toBe('General');
    expect(result.attachments).toHaveLength(0);
    expect(result.whatsapp).toEqual({ requested: false, sent: false });
    expect(gateway.sent).toHaveLength(0);
  });

  it('categoría inexistente → NewsCategoryNotFoundError, no crea post', async () => {
    const { uc, postRepo } = await build();
    await expect(uc.execute({ ...base, category: 'Nope' })).rejects.toBeInstanceOf(
      NewsCategoryNotFoundError,
    );
    expect(await postRepo.list({}, 'x')).toHaveLength(0);
  });

  it('links válidos → se adjuntan; title del caller mapea a filename', async () => {
    const { uc, categoryRepo } = await build();
    await categoryRepo.create({ name: 'General', color: '#64748b' });

    const result = await uc.execute({
      ...base,
      category: 'General',
      links: [
        { url: 'https://x.com/a', title: 'Nota A' },
        { url: 'http://y.com/b' },
      ],
    });

    expect(result.attachments).toHaveLength(2);
    expect(result.attachments[0]!.url).toBe('https://x.com/a');
    expect(result.attachments[0]!.filename).toBe('Nota A');
    expect(result.attachments[1]!.url).toBe('http://y.com/b');
    expect(result.attachments[1]!.filename).toBeNull();
  });

  it('link inválido (no http(s)) → 422 sin crear post ni adjuntos', async () => {
    const { uc, categoryRepo, postRepo, attachmentRepo } = await build();
    await categoryRepo.create({ name: 'General', color: '#64748b' });

    await expect(
      uc.execute({
        ...base,
        category: 'General',
        links: [{ url: 'https://ok.com' }, { url: 'ftp://bad' }],
      }),
    ).rejects.toBeInstanceOf(InvalidLinkAttachmentError);

    expect(await postRepo.list({}, 'x')).toHaveLength(0);
    expect(attachmentRepo.store.size).toBe(0);
  });

  it('más de 20 links → TooManyNewsAttachmentsError sin crear post', async () => {
    const { uc, categoryRepo, postRepo } = await build();
    await categoryRepo.create({ name: 'General', color: '#64748b' });
    const links = Array.from({ length: 21 }, (_, i) => ({ url: `https://x.com/${i}` }));

    await expect(uc.execute({ ...base, category: 'General', links })).rejects.toBeInstanceOf(
      TooManyNewsAttachmentsError,
    );
    expect(await postRepo.list({}, 'x')).toHaveLength(0);
  });

  it('files válidos → se adjuntan como binarios (kind image/file, fileUrl set, url null)', async () => {
    const { uc, categoryRepo } = await build();
    await categoryRepo.create({ name: 'General', color: '#64748b' });

    const result = await uc.execute({
      ...base,
      category: 'General',
      files: [
        { buffer: JPG, originalName: 'foto.jpg', mimeType: 'image/jpeg' },
        { buffer: Buffer.from('%PDF-1.4'), originalName: 'doc.pdf', mimeType: 'application/pdf' },
      ],
    });

    expect(result.attachments).toHaveLength(2);
    expect(result.attachments[0]!.kind).toBe('image');
    expect(result.attachments[0]!.fileUrl).toContain('/api/news/attachments/');
    expect(result.attachments[0]!.url).toBeNull();
    expect(result.attachments[1]!.kind).toBe('file');
    expect(result.attachments[1]!.mimeType).toBe('application/pdf');
  });

  it('tipo de archivo inválido → UnsupportedNewsAttachmentTypeError SIN crear post', async () => {
    const { uc, categoryRepo, postRepo, attachmentRepo } = await build();
    await categoryRepo.create({ name: 'General', color: '#64748b' });

    await expect(
      uc.execute({
        ...base,
        category: 'General',
        files: [{ buffer: Buffer.from('x'), originalName: 'a.exe', mimeType: 'application/x-msdownload' }],
      }),
    ).rejects.toBeInstanceOf(UnsupportedNewsAttachmentTypeError);

    expect(await postRepo.list({}, 'x')).toHaveLength(0);
    expect(attachmentRepo.store.size).toBe(0);
  });

  it('links + files combinados > 20 → TooManyNewsAttachmentsError SIN crear post', async () => {
    const { uc, categoryRepo, postRepo, attachmentRepo } = await build();
    await categoryRepo.create({ name: 'General', color: '#64748b' });
    const links = Array.from({ length: 11 }, (_, i) => ({ url: `https://x.com/${i}` }));
    const files = Array.from({ length: 10 }, (_, i) => ({
      buffer: JPG,
      originalName: `f${i}.jpg`,
      mimeType: 'image/jpeg',
    }));

    await expect(
      uc.execute({ ...base, category: 'General', links, files }),
    ).rejects.toBeInstanceOf(TooManyNewsAttachmentsError);
    expect(await postRepo.list({}, 'x')).toHaveLength(0);
    expect(attachmentRepo.store.size).toBe(0);
  });

  it('files + links + sendToWhatsapp juntos → ok; attachments = links THEN files; whatsapp sent', async () => {
    const { uc, categoryRepo, gateway } = await build();
    await categoryRepo.create({ name: 'General', color: '#64748b' });

    const result = await uc.execute({
      ...base,
      category: 'General',
      links: [{ url: 'https://x.com/a', title: 'Nota A' }],
      files: [{ buffer: JPG, originalName: 'foto.jpg', mimeType: 'image/jpeg' }],
      sendToWhatsapp: true,
    });

    expect(result.attachments).toHaveLength(2);
    // orden garantizado: links primero, luego files
    expect(result.attachments[0]!.kind).toBe('link');
    expect(result.attachments[0]!.url).toBe('https://x.com/a');
    expect(result.attachments[1]!.kind).toBe('image');
    expect(result.attachments[1]!.fileUrl).toContain('/api/news/attachments/');
    expect(result.whatsapp.sent).toBe(true);
    expect(gateway.sent).toHaveLength(1);
  });

  it('storage falla en save (paso 4b) → error propaga Y el post queda COMPENSADO (0 posts, 0 attachments)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { uc, categoryRepo, postRepo, attachmentRepo } = await build(
      'http://panel.local',
      new FailingFileStorage(),
    );
    await categoryRepo.create({ name: 'General', color: '#64748b' });

    await expect(
      uc.execute({
        ...base,
        category: 'General',
        files: [{ buffer: JPG, originalName: 'foto.jpg', mimeType: 'image/jpeg' }],
      }),
    ).rejects.toThrow('storage down');

    // all-or-nothing también en 5xx: NO queda post huérfano ni adjuntos.
    expect(await postRepo.list({}, 'x')).toHaveLength(0);
    expect(attachmentRepo.store.size).toBe(0);
    warnSpy.mockRestore();
  });

  it('sin archivos (solo links) NO cambia — un broadcast que falla NO borra la noticia', async () => {
    // Guard-rail: la compensación de adjuntos NO debe alcanzar al broadcast best-effort.
    const { uc, categoryRepo, postRepo, gateway } = await build();
    await categoryRepo.create({ name: 'General', color: '#64748b' });
    gateway.error = new NocBroadcastNotConfiguredError();

    const result = await uc.execute({
      ...base,
      category: 'General',
      links: [{ url: 'https://x.com/a' }],
      sendToWhatsapp: true,
    });

    expect(result.attachments).toHaveLength(1);
    expect(result.whatsapp.sent).toBe(false);
    // el post SIGUE creado — el fallo de broadcast NO dispara compensación
    expect(await postRepo.list({}, 'x')).toHaveLength(1);
  });

  it('sendToWhatsapp true + gateway ok → whatsapp.sent true con link', async () => {
    const { uc, categoryRepo, gateway } = await build();
    await categoryRepo.create({ name: 'General', color: '#64748b' });

    const result = await uc.execute({ ...base, category: 'General', sendToWhatsapp: true });

    expect(result.whatsapp.requested).toBe(true);
    expect(result.whatsapp.sent).toBe(true);
    expect(result.whatsapp.link).toContain('/admin/news?post=');
    expect(result.whatsapp.error).toBeUndefined();
    expect(gateway.sent).toHaveLength(1);
  });

  it('sendToWhatsapp true + gateway NocBroadcastNotConfigured → sent:false + error (best-effort, post SÍ se crea)', async () => {
    const { uc, categoryRepo, postRepo, gateway } = await build();
    await categoryRepo.create({ name: 'General', color: '#64748b' });
    gateway.error = new NocBroadcastNotConfiguredError();

    const result = await uc.execute({ ...base, category: 'General', sendToWhatsapp: true });

    expect(result.whatsapp).toEqual({
      requested: true,
      sent: false,
      error: 'NOC_BROADCAST_NOT_CONFIGURED',
    });
    // best-effort: la noticia YA quedó creada aunque el whatsapp falle
    expect(await postRepo.list({}, 'x')).toHaveLength(1);
  });

  it('sendToWhatsapp true + gateway EvolutionApiError → sent:false + EVOLUTION_API_ERROR', async () => {
    const { uc, categoryRepo, gateway } = await build();
    await categoryRepo.create({ name: 'General', color: '#64748b' });
    gateway.error = new EvolutionApiError('boom');

    const result = await uc.execute({ ...base, category: 'General', sendToWhatsapp: true });
    expect(result.whatsapp).toEqual({ requested: true, sent: false, error: 'EVOLUTION_API_ERROR' });
  });

  it('sendToWhatsapp true + appPublicUrl vacío → sent:false + NOC_BROADCAST_LINK_BASE_MISSING', async () => {
    const { uc, categoryRepo } = await build(''); // appPublicUrl empty
    await categoryRepo.create({ name: 'General', color: '#64748b' });

    const result = await uc.execute({ ...base, category: 'General', sendToWhatsapp: true });
    expect(result.whatsapp).toEqual({
      requested: true,
      sent: false,
      error: 'NOC_BROADCAST_LINK_BASE_MISSING',
    });
  });

  it('errores DESCONOCIDOS del broadcast SÍ propagan (no se tragan)', async () => {
    const { uc, categoryRepo, gateway } = await build();
    await categoryRepo.create({ name: 'General', color: '#64748b' });
    gateway.error = new Error('unexpected boom');

    await expect(
      uc.execute({ ...base, category: 'General', sendToWhatsapp: true }),
    ).rejects.toThrow('unexpected boom');
  });

  it('sendToWhatsapp false/ausente → no intenta difundir', async () => {
    const { uc, categoryRepo, gateway } = await build();
    await categoryRepo.create({ name: 'General', color: '#64748b' });

    const result = await uc.execute({ ...base, category: 'General' });
    expect(result.whatsapp).toEqual({ requested: false, sent: false });
    expect(gateway.sent).toHaveLength(0);
  });
});
