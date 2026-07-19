import { NewsCategoryRepository } from '@domain/ports/NewsCategoryRepository';
import { NewsPostRepository } from '@domain/ports/NewsPostRepository';
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
import {
  AttachFilesToNews,
  AttachNewsFile,
  MAX_ATTACHMENTS_PER_POST,
  validateNewsFilesBatch,
} from '@application/use-cases/AttachFilesToNews';
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
  /** Binary attachments (images / pdf / .md). Validated up-front, attached AFTER links. */
  files?: AttachNewsFile[];
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
 *   2. Validate links + files up-front (COMBINED count ≤ 20, http(s) link shape, file
 *      types) BEFORE creating anything — a bad input must NOT leave a half-created post
 *      (all-or-nothing 4xx: 422 too-many/invalid-link, 415 bad file type).
 *   3. Create the post (reusing CreateNewsPost), stamping the system "api" author.
 *   4. Attach each link (reusing AttachLinkToNews); caller `title` → `filename`.
 *   4b. Attach the binaries (reusing AttachFilesToNews). `attachments` order = links THEN files.
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
    private readonly attachFilesToNews: AttachFilesToNews,
    /** Only `delete` is used — hard-delete compensation if the attach phase fails (5xx). */
    private readonly newsPosts: Pick<NewsPostRepository, 'delete'>,
  ) {}

  async execute(input: CreateExternalNewsInput): Promise<CreateExternalNewsResult> {
    // 1. Category by NAME (422 if unknown). Reuses the domain error CreateNewsPost
    //    throws for a bad id — same code, resolved by name here.
    const category = await this.categoryRepo.findByName(input.category);
    if (!category) throw new NewsCategoryNotFoundError(input.category);

    // 2. Validate links + files UP-FRONT (all-or-nothing on the 4xx path). The combined
    //    count cap, the http(s) link shape AND the file types are checked BEFORE any
    //    write, so a bad input never leaves an orphan post/attachments behind.
    const links = input.links ?? [];
    const files = input.files ?? [];

    // 2.1 Combined cap: links + files must not exceed the per-post ceiling (422).
    if (links.length + files.length > MAX_ATTACHMENTS_PER_POST) {
      throw new TooManyNewsAttachmentsError(MAX_ATTACHMENTS_PER_POST);
    }
    // 2.2 Link shape — same domain validator AttachLinkToNews enforces (422).
    for (const link of links) {
      if (!isValidHttpUrl((link.url ?? '').trim())) {
        throw new InvalidLinkAttachmentError();
      }
    }
    // 2.3 File types — reuse AttachFilesToNews's pure batch validator (415 on bad type /
    //     0-byte). Runs UPFRONT so a bad file never leaves a half-created post. The later
    //     attachFilesToNews.execute re-validates harmlessly (idempotent classify).
    validateNewsFilesBatch(files);

    // 3. Create the post — authored by the system "api" user (resolved at the route).
    const post = await this.createNewsPost.execute({
      title: input.title,
      body: input.body,
      categoryId: category.id,
      pinned: input.pinned,
      authorId: input.authorId,
      authorName: input.authorName,
    });

    // 4 + 4b. ATTACH PHASE — wrapped so a storage/infra failure honours all-or-nothing
    //   even on the 5xx path: if attaching links OR files throws, HARD-DELETE the just-
    //   created post (cascade wipes any link rows; AttachFilesToNews already compensated
    //   its own partial storage) so a caller retry never duplicates the post. The delete
    //   is BEST-EFFORT: if IT fails, log and re-throw the ORIGINAL error (not the delete's).
    //   Broadcast (step 5) is deliberately OUTSIDE this try — a broadcast failure must NOT
    //   roll back an already-persisted news post.
    const attachments: NewsPostAttachmentDto[] = [];
    try {
      // 4. Attach each link (already validated; AttachLinkToNews re-checks harmlessly).
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

      // 4b. Attach the binaries AFTER the links (attachments order = links THEN files).
      if (files.length > 0) {
        const fileDtos = await this.attachFilesToNews.execute({
          newsPostId: post.id,
          uploadedById: input.authorId,
          files,
        });
        attachments.push(...fileDtos);
      }
    } catch (err) {
      try {
        await this.newsPosts.delete(post.id);
      } catch (compErr) {
        // eslint-disable-next-line no-console
        console.warn(
          `[CreateExternalNews] compensation failed to hard-delete orphan post "${post.id}" ` +
            `after an attach error (post left behind): ${String(compErr)}`,
        );
      }
      throw err;
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
      const result = await this.broadcastNewsToNoc.execute(postId, input.authorId, input.authorName);
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
