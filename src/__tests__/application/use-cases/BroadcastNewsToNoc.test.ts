/**
 * N2 — BroadcastNewsToNoc: wraps the N1 engine (BroadcastToNoc) for a news post.
 * Sends "📢 {title}\n🔗 {link}" with a deep link to /admin/news?post={id}.
 * NOT best-effort: gateway errors propagate AND lastBroadcastAt is NOT stamped on failure.
 */
import { BroadcastNewsToNoc } from '@application/use-cases/BroadcastNewsToNoc';
import { BroadcastToNoc } from '@application/use-cases/nocBroadcast/BroadcastToNoc';
import { InMemoryNocBroadcastConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryNocBroadcastConfigRepository';
import { InMemoryNewsPostRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsPostRepository';
import { InMemoryNewsCategoryRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsCategoryRepository';
import { NocBroadcastGateway } from '@domain/ports/NocBroadcastGateway';
import { NewsPostNotFoundError } from '@domain/errors/news';
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

async function build(appPublicUrl = 'http://190.7.234.37:7778') {
  const categoryRepo = new InMemoryNewsCategoryRepository();
  const postRepo = new InMemoryNewsPostRepository(categoryRepo);
  const cat = await categoryRepo.create({ name: 'Red', color: '#6366f1' });
  const post = await postRepo.create({
    title: 'Corte programado Zona Norte',
    body: 'B',
    categoryId: cat.id,
    authorId: 'a',
    authorName: 'A',
  });
  const config = new InMemoryNocBroadcastConfigRepository();
  await config.update({ appPublicUrl });
  const gateway = new FakeGateway();
  const uc = new BroadcastNewsToNoc(postRepo, new BroadcastToNoc(config, gateway));
  return { postRepo, gateway, uc, postId: post.id };
}

describe('BroadcastNewsToNoc', () => {
  it('post existente → 📢 title + link /admin/news?post={id}; stamps lastBroadcastAt + actor', async () => {
    const { uc, gateway, postRepo, postId } = await build();
    const result = await uc.execute(postId, 'u1', 'Tino');

    expect(result).toEqual({
      sent: true,
      link: `http://190.7.234.37:7778/admin/news?post=${postId}`,
    });
    expect(gateway.sent).toEqual([
      `📢 Corte programado Zona Norte\n🔗 http://190.7.234.37:7778/admin/news?post=${postId}`,
    ]);
    const post = await postRepo.findById(postId, 'u1');
    expect(post!.lastBroadcastAt).not.toBeNull();
    // noc-broadcast-traceability — el actorName llega al repo y queda en la noticia.
    expect(post!.lastBroadcastByName).toBe('Tino');
  });

  it('post inexistente → NewsPostNotFoundError, gateway nunca llamado', async () => {
    const { uc, gateway } = await build();
    await expect(uc.execute('ghost', 'u1', 'Tino')).rejects.toBeInstanceOf(NewsPostNotFoundError);
    expect(gateway.sent).toHaveLength(0);
  });

  it('propaga NocBroadcastNotConfiguredError (503) y NO estampa lastBroadcastAt/actor', async () => {
    const { uc, gateway, postRepo, postId } = await build();
    gateway.error = new NocBroadcastNotConfiguredError();
    await expect(uc.execute(postId, 'u1', 'Tino')).rejects.toBeInstanceOf(NocBroadcastNotConfiguredError);
    const post = await postRepo.findById(postId, 'u1');
    expect(post!.lastBroadcastAt).toBeNull();
    expect(post!.lastBroadcastByName).toBeNull();
  });

  it('propaga EvolutionApiError (502)', async () => {
    const { uc, gateway, postId } = await build();
    gateway.error = new EvolutionApiError('boom');
    await expect(uc.execute(postId, 'u1', 'Tino')).rejects.toBeInstanceOf(EvolutionApiError);
  });
});
