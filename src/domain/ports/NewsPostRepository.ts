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
  /** Idempotent upsert — repeated calls for the same (post, user) leave ONE receipt. */
  markRead(postId: string, userId: string): Promise<void>;
  /** Count of non-archived posts with no read receipt from this user. */
  countUnread(userId: string): Promise<number>;
}
