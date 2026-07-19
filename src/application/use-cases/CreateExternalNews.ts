import { NewsCategoryRepository } from '@domain/ports/NewsCategoryRepository';
import { NewsCategoryNotFoundError } from '@domain/errors/news';
import {
  InvalidLinkAttachmentError,
  TooManyNewsAttachmentsError,
} from '@domain/errors/newsAttachment';
import { DomainError } from '@domain/errors';
import {
  NocBroadcastNotConfiguredError,
  EvolutionApiError,
  NocBroadcastLinkBaseMissingError,
  TaskNotBroadcastableError,
} from '@domain/errors/nocBroadcast';
import { CreateNewsPost } from '@application/use-cases/CreateNewsPost';
import { AttachLinkToNews } from '@application/use-cases/AttachLinkToNews';
import { BroadcastNewsToNoc } from '@application/use-cases/BroadcastNewsToNoc';
import { MAX_ATTACHMENTS_PER_POST } from '@application/use-cases/AttachFilesToNews';
import { isValidHttpUrl } from '@domain/services/httpUrl';
import { NewsPostDto } from '@application/dto/news.dto';
import { NewsPostAttachmentDto } from '@application/dto/newsAttachment.dto';

export interface CreateExternalNewsLink {
  url: string;
  /** Optional human label — stored as the attachment `filename`. */
  title?: string;
}

export interface CreateExternalNewsInput {
  title: string;
  body: string;
  /** Category NAME (resolved against the catalog). */
  category: string;
  pinned?: boolean;
  links?: CreateExternalNewsLink[];
  sendToWhatsapp?: boolean;
  /** System "api" reporter id, resolved by the route. */
  authorId: string;
  /** System "api" reporter display name. */
  authorName: string;
}

export interface ExternalNewsWhatsappResult {
  requested: boolean;
  sent: boolean;
  /** Absolute deep link included in the WhatsApp message (only when sent). */
  link?: string;
  /** Domain error `code` when a KNOWN broadcast error was swallowed (best-effort). */
  error?: string;
}

export interface CreateExternalNewsResult {
  post: NewsPostDto;
  attachments: NewsPostAttachmentDto[];
  whatsapp: ExternalNewsWhatsappResult;
}

/**
 * external-news — orchestrates the 2nd external WRITE (POST /api/external/v1/news).
 *
 * Pure orchestration over existing use cases + the category port (DIP: NO Prisma, NO
 * infrastructure). Flow:
 *   1. Resolve category BY NAME → NewsCategoryNotFoundError (422) if unknown.
 *   2. Validate ALL links up-front (count ≤ 20, http(s) shape) BEFORE creating
 *      anything — a bad link must NOT leave a half-created post (all-or-nothing 4xx).
 *   3. Create the post (reusing CreateNewsPost), stamping the system "api" author.
 *   4. Attach each link (reusing AttachLinkToNews); caller `title` → `filename`.
 *   5. If sendToWhatsapp: broadcast (reusing BroadcastNewsToNoc) BEST-EFFORT — a
 *      KNOWN nocBroadcast domain error does NOT roll back the post; it surfaces as
 *      { requested:true, sent:false, error:<code> }. Unknown errors DO propagate.
 */
export class CreateExternalNews {
  constructor(
    private readonly categoryRepo: NewsCategoryRepository,
    private readonly createNewsPost: CreateNewsPost,
    private readonly attachLinkToNews: AttachLinkToNews,
    private readonly broadcastNewsToNoc: BroadcastNewsToNoc,
  ) {}

  async execute(input: CreateExternalNewsInput): Promise<CreateExternalNewsResult> {
    // 1. Category by NAME (422 if unknown). Reuses the domain error CreateNewsPost
    //    throws for a bad id — same code, resolved by name here.
    const category = await this.categoryRepo.findByName(input.category);
    if (!category) throw new NewsCategoryNotFoundError(input.category);

    // 2. Validate links UP-FRONT (all-or-nothing on the 4xx path). Both the count
    //    cap and the http(s) shape are checked BEFORE any write, so a bad link never
    //    leaves an orphan post/attachments behind.
    const links = input.links ?? [];
    if (links.length > MAX_ATTACHMENTS_PER_POST) {
      throw new TooManyNewsAttachmentsError(MAX_ATTACHMENTS_PER_POST);
    }
    for (const link of links) {
      // Same domain validator AttachLinkToNews enforces — checked UPFRONT so a bad link
      // never leaves a half-created post (all-or-nothing on the 4xx path).
      if (!isValidHttpUrl((link.url ?? '').trim())) {
        throw new InvalidLinkAttachmentError();
      }
    }

    // 3. Create the post — authored by the system "api" user (resolved at the route).
    const post = await this.createNewsPost.execute({
      title: input.title,
      body: input.body,
      categoryId: category.id,
      pinned: input.pinned,
      authorId: input.authorId,
      authorName: input.authorName,
    });

    // 4. Attach each link (already validated; AttachLinkToNews re-checks harmlessly).
    const attachments: NewsPostAttachmentDto[] = [];
    for (const link of links) {
      attachments.push(
        await this.attachLinkToNews.execute({
          newsPostId: post.id,
          uploadedById: input.authorId,
          url: link.url,
          filename: link.title,
        }),
      );
    }

    // 5. Broadcast BEST-EFFORT — known nocBroadcast errors are swallowed with a status.
    const whatsapp = await this.maybeBroadcast(post.id, input);
    return { post, attachments, whatsapp };
  }

  private async maybeBroadcast(
    postId: string,
    input: CreateExternalNewsInput,
  ): Promise<ExternalNewsWhatsappResult> {
    if (input.sendToWhatsapp !== true) {
      return { requested: false, sent: false };
    }
    try {
      const result = await this.broadcastNewsToNoc.execute(postId, input.authorId);
      return { requested: true, sent: true, link: result.link };
    } catch (err) {
      // Best-effort: a KNOWN broadcast failure does NOT roll back the created post —
      // it surfaces as a status. Anything else is unexpected → propagate.
      if (isKnownBroadcastError(err)) {
        return { requested: true, sent: false, error: err.code };
      }
      throw err;
    }
  }
}

/** True for any DomainError originating from @domain/errors/nocBroadcast. */
function isKnownBroadcastError(err: unknown): err is DomainError {
  return (
    err instanceof NocBroadcastNotConfiguredError ||
    err instanceof EvolutionApiError ||
    err instanceof NocBroadcastLinkBaseMissingError ||
    err instanceof TaskNotBroadcastableError
  );
}
