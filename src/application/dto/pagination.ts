/**
 * L5 (fix wave, customer-portal-api) — los tipos viven ahora en
 * `domain/entities/pagination.ts` (los ports de domain los usan y el dominio no
 * importa de application). Este modulo queda como re-export para que TODOS los
 * consumidores existentes de application/infrastructure sigan compilando sin
 * tocar un import.
 */
export type { PaginatedQuery, PaginatedResult } from '@domain/entities/pagination';
