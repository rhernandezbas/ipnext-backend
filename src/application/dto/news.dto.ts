import { z } from 'zod';
import { NewsCategory, NewsPost } from '@domain/entities/news';
import { NewsPostAttachmentDto } from '@application/dto/newsAttachment.dto';

// 6-digit hex color (e.g. #6366f1) — same shape as tickets.dto.ts's HexColorSchema,
// redefined locally since that one isn't exported.
const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be a 6-digit hex like #6366f1');

// ─── NewsCategory DTOs ─────────────────────────────────────────────────────────

export interface NewsCategoryDto {
  id: string;
  name: string;
  color: string;
}

export function toNewsCategoryDto(category: NewsCategory): NewsCategoryDto {
  return { id: category.id, name: category.name, color: category.color };
}

// .trim() before .min(1): a name of " " would otherwise slip past the uniqueness
// conflict check by carrying invisible whitespace (molde tickets.dto.ts:66-74).
// .max(60) (review fix L6): no cap in the spec/design — 60 mirrors the sidebar-chip
// / settings-list use of category names (short labels, not free text like a post title).
export const CreateNewsCategorySchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: HexColorSchema,
});
export const UpdateNewsCategorySchema = CreateNewsCategorySchema.partial();
export type CreateNewsCategoryInput = z.infer<typeof CreateNewsCategorySchema>;
export type UpdateNewsCategoryInput = z.infer<typeof UpdateNewsCategorySchema>;

// ─── NewsPost DTOs ───────────────────────────────────────────────────────────

/** Output DTO — never expose raw Prisma rows. `read` is per-requesting-user state. */
export interface NewsPostDto {
  id: string;
  title: string;
  body: string;
  category: NewsCategoryDto;
  authorId: string | null;
  authorName: string;
  pinned: boolean;
  publishedAt: string;
  archivedAt: string | null;
  /** N2 — última difusión al NOC (ISO) o null si nunca se difundió. */
  lastBroadcastAt: string | null;
  read: boolean;
  /** N2 — adjuntos (imágenes/archivos/links) de la noticia. Vacío si no tiene. */
  attachments: NewsPostAttachmentDto[];
  createdAt: string;
  updatedAt: string;
}

/**
 * `read` is passed explicitly — callers with a `NewsPostWithReadState` pass
 * `post.read`; callers with a plain `NewsPost` (create/update/archive, which
 * don't carry per-user state) pass `false`.
 *
 * `attachments` defaults to `[]` so the mutation use cases (create/update/archive),
 * which don't hydrate attachments, keep compiling untouched and simply return an
 * empty list — the read paths (Get/List) pass the hydrated array explicitly.
 */
export function toNewsPostDto(
  post: NewsPost,
  read: boolean,
  attachments: NewsPostAttachmentDto[] = [],
): NewsPostDto {
  return {
    id: post.id,
    title: post.title,
    body: post.body,
    category: toNewsCategoryDto(post.category),
    authorId: post.authorId,
    authorName: post.authorName,
    pinned: post.pinned,
    publishedAt: post.publishedAt.toISOString(),
    archivedAt: post.archivedAt ? post.archivedAt.toISOString() : null,
    lastBroadcastAt: post.lastBroadcastAt ? post.lastBroadcastAt.toISOString() : null,
    read,
    attachments,
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
  };
}

export interface ListNewsPostsResultDto {
  items: NewsPostDto[];
  unreadCount: number;
}

// body: texto MARKDOWN multiline (N2). El BE lo persiste TAL CUAL (no parsea ni sanitiza
// markdown acá); el FE es quien lo renderiza. Sigue siendo un string plano en el modelo —
// no cambia nada estructural, sólo la interpretación en el cliente. trim ANTES de min
// (molde tickets.dto.ts); max 20000 cubre un post largo con markdown.
export const CreateNewsPostSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20000),
  categoryId: z.string().min(1),
  pinned: z.boolean().optional(),
});
export const UpdateNewsPostSchema = CreateNewsPostSchema.partial();
export type CreateNewsPostInput = z.infer<typeof CreateNewsPostSchema>;
export type UpdateNewsPostInput = z.infer<typeof UpdateNewsPostSchema>;

export const ArchiveNewsPostSchema = z.object({ archived: z.boolean() });
export type ArchiveNewsPostInput = z.infer<typeof ArchiveNewsPostSchema>;
