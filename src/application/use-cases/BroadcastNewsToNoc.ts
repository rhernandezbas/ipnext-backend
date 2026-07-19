import { NewsPostRepository } from '@domain/ports/NewsPostRepository';
import { NewsPostNotFoundError } from '@domain/errors/news';
import {
  BroadcastToNoc,
  BroadcastToNocResult,
} from '@application/use-cases/nocBroadcast/BroadcastToNoc';

/**
 * N2 — difunde una noticia al canal NOC (WhatsApp) reusando el motor N1 (BroadcastToNoc).
 *
 * Mensaje: "📢 {title}\n🔗 {link}" con deep link a `/admin/news?post={id}` (el board FE
 * abre el post por query param — el FE debe soportar `?post=<id>`). NO es best-effort: es
 * un botón, los errores del gateway (503 no configurado, 502 Evolution, 422 sin appPublicUrl)
 * PROPAGAN. `lastBroadcastAt` se estampa SOLO tras un envío exitoso (si el gateway falla, el
 * throw sale antes de estampar).
 */
export class BroadcastNewsToNoc {
  constructor(
    private readonly posts: NewsPostRepository,
    private readonly broadcast: BroadcastToNoc,
  ) {}

  async execute(postId: string, userId: string, actorName: string): Promise<BroadcastToNocResult> {
    const post = await this.posts.findById(postId, userId);
    if (!post) throw new NewsPostNotFoundError(postId);

    const result = await this.broadcast.execute({
      kind: 'news',
      title: post.title,
      relativePath: `/admin/news?post=${post.id}`,
    });

    // Solo si el envío no lanzó: registrar la difusión + el actor (badge "Última difusión").
    await this.posts.recordBroadcast(post.id, actorName);
    return result;
  }
}
