import { NewsPostRepository } from '@domain/ports/NewsPostRepository';
import { NewsPostAttachmentRepository } from '@domain/ports/NewsPostAttachmentRepository';
import { NewsPostNotFoundError } from '@domain/errors/news';
import { NewsPostDto, toNewsPostDto } from '@application/dto/news.dto';
import { toNewsPostAttachmentDto } from '@application/dto/newsAttachment.dto';

/** Reader mínimo de adjuntos (solo lo que el detalle necesita). El repo full lo satisface. */
type NewsAttachmentReader = Pick<NewsPostAttachmentRepository, 'findByNewsPostId'>;

/**
 * Detail lookup — does NOT mark the post as read (design §6.1: the mark is explicit via
 * MarkNewsRead). N2: hydrates the post's attachments into the DTO.
 *
 * The attachment reader defaults to an empty null-object so pre-N2 call sites (which
 * only passed the post repo) keep compiling and simply return `attachments: []`.
 */
export class GetNewsPost {
  constructor(
    private readonly postRepo: NewsPostRepository,
    private readonly attachmentRepo: NewsAttachmentReader = { async findByNewsPostId() { return []; } },
  ) {}

  async execute(id: string, userId: string): Promise<NewsPostDto> {
    const post = await this.postRepo.findById(id, userId);
    if (!post) throw new NewsPostNotFoundError(id);
    const attachments = await this.attachmentRepo.findByNewsPostId(id);
    return toNewsPostDto(post, post.read, attachments.map(toNewsPostAttachmentDto));
  }
}
