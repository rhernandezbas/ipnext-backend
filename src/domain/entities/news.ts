/**
 * internal-news — domain entities for the team news board.
 *
 * `NewsPost.category` is JOIN-derived (the category is embedded, not just its id) —
 * mirrors the DTO shape in design §5.4 (`NewsPostDto.category: NewsCategoryDto`).
 */

export interface NewsCategory {
  id: string;
  name: string;
  color: string;
}

export interface NewsPost {
  id: string;
  title: string;
  body: string;
  categoryId: string;
  category: NewsCategory;
  authorId: string | null;
  authorName: string;
  pinned: boolean;
  publishedAt: Date;
  archivedAt: Date | null;
  /** N2 — última vez que la noticia se difundió al NOC (WhatsApp). null = nunca. */
  lastBroadcastAt: Date | null;
  /** noc-broadcast-traceability — nombre (snapshot) del actor de la última difusión. null = nunca. */
  lastBroadcastByName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Read model: `NewsPost` + whether the requesting user has read it. `read` is
 * per-user state derived from `NewsReadReceipt` — it is NOT a property of the
 * entity itself (design §5.1).
 */
export type NewsPostWithReadState = NewsPost & { read: boolean };
