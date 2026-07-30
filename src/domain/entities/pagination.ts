/**
 * Pagination value shapes — domain layer (fix wave L5, customer-portal-api).
 *
 * Vivian en `application/dto/pagination.ts`, pero 8 ports de `domain/ports/`
 * los importaban — violacion DIP (el dominio no importa de application).
 * Movidos aca; `application/dto/pagination.ts` los re-exporta para que ningun
 * consumidor de application/infrastructure cambie.
 */
export interface PaginatedQuery {
  page?: number;
  limit?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}
