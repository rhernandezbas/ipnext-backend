import { NewsPostAttachment } from '@domain/entities/newsPostAttachment';

/**
 * N2 — repositorio de adjuntos de una NewsPost.
 *
 * `countByNewsPostId` existe para aplicar el cupo por noticia sin materializar filas.
 * `findByNewsPostIds` es la variante batch que ListNewsPosts usa para hidratar los
 * adjuntos de toda una página en UNA query (evita N+1).
 */
export interface NewsPostAttachmentRepository {
  create(attachment: NewsPostAttachment): Promise<NewsPostAttachment>;
  findById(id: string): Promise<NewsPostAttachment | null>;
  findByNewsPostId(newsPostId: string): Promise<NewsPostAttachment[]>;
  /** Todos los adjuntos de los posts indicados, en una sola pasada (para el listado). */
  findByNewsPostIds(newsPostIds: string[]): Promise<NewsPostAttachment[]>;
  delete(id: string): Promise<void>;
  countByNewsPostId(newsPostId: string): Promise<number>;
}
