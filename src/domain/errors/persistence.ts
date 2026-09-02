/**
 * external-bulk-messaging fix wave F1 (finding F5) — errores de PERSISTENCIA
 * traducidos por los adapters, para que `application/` pueda reaccionar a una
 * carrera sin conocer a Prisma.
 *
 * Por que existe: el patron del repo para una violacion de unique es
 * duck-typing del codigo crudo de Prisma (`(e as {code?}).code === 'P2002'`) en
 * la capa de RUTA (`inventory.routes.ts`, `vehicle.routes.ts`). Eso no sirve
 * cuando el que tiene que recuperarse es un USE CASE: `SendExternalBulk` debe
 * responder la campana GANADORA (idempotencia, SEND-6), no propagar un 500 —
 * y no puede importar el codigo de error de Prisma sin romper DIP. El adapter
 * traduce P2002 a este error tipado; el use case lo cachea y re-lee.
 */
import { DomainError } from './index';

/**
 * Una escritura choco contra un indice UNIQUE. `entity`/`field` son
 * best-effort (informativos): lo que el caller necesita saber es "alguien mas
 * ya escribio esta fila", y quien pueda recuperarse re-lee.
 */
export class UniqueConstraintViolationError extends DomainError {
  public readonly entity: string;
  public readonly field: string | null;

  constructor(entity: string, field: string | null = null) {
    super(
      `Unique constraint violated on ${entity}${field ? `.${field}` : ''}`,
      'UNIQUE_CONSTRAINT_VIOLATION',
    );
    this.name = 'UniqueConstraintViolationError';
    this.entity = entity;
    this.field = field;
  }
}
