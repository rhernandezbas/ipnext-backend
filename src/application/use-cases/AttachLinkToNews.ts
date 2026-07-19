import { randomUUID } from 'crypto';
import { NewsPostAttachmentRepository } from '@domain/ports/NewsPostAttachmentRepository';
import { NewsPostRepository } from '@domain/ports/NewsPostRepository';
import { createNewsPostAttachment } from '@domain/entities/newsPostAttachment';
import { NewsPostNotFoundError } from '@domain/errors/news';
import { InvalidLinkAttachmentError } from '@domain/errors/newsAttachment';
import { isValidHttpUrl } from '@domain/services/httpUrl';
import {
  NewsPostAttachmentDto,
  toNewsPostAttachmentDto,
} from '@application/dto/newsAttachment.dto';

export interface AttachLinkToNewsInput {
  newsPostId: string;
  uploadedById: string;
  url: string;
  /** Rótulo humano opcional del link. */
  filename?: string;
}

/**
 * Adjunta un LINK externo a una noticia (sin binario, sin storage). Valida que la noticia
 * exista y que la URL sea http(s) no vacía; cualquier otro esquema (javascript:, ftp:, …)
 * → InvalidLinkAttachmentError (422). Persiste una fila kind='link' con `url`.
 */
export class AttachLinkToNews {
  constructor(
    private readonly attachments: NewsPostAttachmentRepository,
    private readonly posts: Pick<NewsPostRepository, 'findById'>,
  ) {}

  async execute(input: AttachLinkToNewsInput): Promise<NewsPostAttachmentDto> {
    const post = await this.posts.findById(input.newsPostId, input.uploadedById);
    if (!post) throw new NewsPostNotFoundError(input.newsPostId);

    const url = (input.url ?? '').trim();
    if (!isValidHttpUrl(url)) {
      throw new InvalidLinkAttachmentError();
    }

    const entity = await this.attachments.create(
      createNewsPostAttachment({
        id: randomUUID(),
        newsPostId: input.newsPostId,
        kind: 'link',
        url,
        filename: input.filename ?? null,
        uploadedById: input.uploadedById,
      }),
    );
    return toNewsPostAttachmentDto(entity);
  }
}
