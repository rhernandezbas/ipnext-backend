import { DomainError } from './index';

// ─── internal-news domain errors (design §5.3, calco errors/tickets.ts) ─────────

export class NewsPostNotFoundError extends DomainError {
  constructor(id: string) {
    super(`NewsPost with id ${id} not found`, 'NEWS_POST_NOT_FOUND');
    this.name = 'NewsPostNotFoundError';
  }
}

/**
 * Thrown both by the category CRUD (404 — the category itself doesn't exist) and
 * by CreateNewsPost/UpdateNewsPost when `categoryId` references a non-existent
 * category (422 — well-formed request, invalid reference; molde de la validación
 * up-front del reporterId en tickets.routes.ts:460-466). The HTTP status is
 * decided per-route in news.routes.ts, NOT in the global errorHandler statusMap.
 */
export class NewsCategoryNotFoundError extends DomainError {
  constructor(id: string) {
    super(`NewsCategory with id ${id} not found`, 'NEWS_CATEGORY_NOT_FOUND');
    this.name = 'NewsCategoryNotFoundError';
  }
}

export class NewsCategoryNameConflictError extends DomainError {
  constructor(name: string) {
    super(`A news category named "${name}" already exists`, 'NEWS_CATEGORY_NAME_CONFLICT');
    this.name = 'NewsCategoryNameConflictError';
  }
}

export class NewsCategoryInUseError extends DomainError {
  constructor(public readonly postCount: number) {
    super(`NewsCategory is in use by ${postCount} post(s)`, 'NEWS_CATEGORY_IN_USE');
    this.name = 'NewsCategoryInUseError';
  }
}
