import { NewsPost, NewsPostWithReadState } from '@domain/entities/news';

export interface NewsPostListFilters {
  categoryId?: string;
  /** default false (excludes archived); true = ONLY archived. */
  archived?: boolean;
}

export interface CreateNewsPostData {
  title: string;
  body: string;
  categoryId: string;
  authorId: string | null;
  authorName: string;
  pinned?: boolean;
}

export interface UpdateNewsPostData {
  title?: string;
  body?: string;
  categoryId?: string;
  pinned?: boolean;
}

/**
 * NewsPostRepository — includes the per-user read state (design §5.1).
 *
 * `create`/`update`/`setArchived` return the plain entity (no read state — the
 * caller doesn't need it for those operations). `findById`/`list` take a
 * `userId` and return `NewsPostWithReadState` (`read` derived from
 * `NewsReadReceipt`).
 *
 * `NewsReadReceipt` has no lifecycle of its own — it's data derived from the
 * (post, user) pair, so its operations (`markRead`/`countUnread`) live here
 * instead of a separate port.
 */
export interface NewsPostRepository {
  create(input: CreateNewsPostData): Promise<NewsPost>;
  update(id: string, patch: UpdateNewsPostData): Promise<NewsPost | null>;
  findById(id: string, userId: string): Promise<NewsPostWithReadState | null>;
  /** Ordered pinned DESC, publishedAt DESC. Excludes archived by default. */
  list(filters: NewsPostListFilters, userId: string): Promise<NewsPostWithReadState[]>;
  setArchived(id: string, archived: boolean): Promise<NewsPost | null>;
  /**
   * HARD delete a post (row + cascade: `NewsPostAttachment` and `NewsReadReceipt` have
   * `onDelete: Cascade`). Distinct from `setArchived` (soft). Idempotent: deleting a
   * missing post is a no-op, NOT an error. Used as the compensation step when an
   * orchestrator must undo a just-created post (all-or-nothing on the 5xx path).
   */
  delete(id: string): Promise<void>;
  /** Idempotent upsert — repeated calls for the same (post, user) leave ONE receipt. */
  markRead(postId: string, userId: string): Promise<void>;
  /** Count of non-archived posts with no read receipt from this user. */
  countUnread(userId: string): Promise<number>;
  /**
   * N2 / noc-broadcast-traceability — stamp lastBroadcastAt = now AND lastBroadcastByName =
   * actorName after a successful NOC broadcast. No-op if the post is gone.
   */
  recordBroadcast(id: string, actorName: string): Promise<void>;
}
