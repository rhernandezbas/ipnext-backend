import {
  ExternalBulkPreview,
  ExternalBulkPreviewRecipient,
  ExternalBulkPreviewInvalidEntry,
  ExternalBulkPreviewCreditSnapshot,
} from '@domain/entities/externalBulkPreview';

/** Datos para crear un preview (task 1.1/1.4) — el repo completa id/consumedAt/createdAt. */
export interface ExternalBulkPreviewCreateData {
  payloadHash: string;
  templateRef: string;
  templateName: string;
  variables: Record<string, string>;
  chatwootLabel: string | null;
  recipients: ExternalBulkPreviewRecipient[];
  invalid: ExternalBulkPreviewInvalidEntry[];
  validCount: number;
  invalidCount: number;
  /**
   * twilio-credit-guard (D1.b) — opcional para no romper callers que no
   * calculan crédito (tests que arman un preview a mano); ausente ⇒ `null`
   * en la entidad creada, nunca un valor fabricado.
   */
  credit?: ExternalBulkPreviewCreditSnapshot | null;
  /** ISO — `createdAt + 15min`, ya resuelto por el caller (use case). */
  expiresAt: string;
}

/**
 * external-bulk-messaging (D3) — port del preview efímero de 2 pasos.
 * Adapters: `PrismaExternalBulkPreviewRepository` (1.6) + `InMemoryExternalBulkPreviewRepository`
 * (1.5, tests).
 */
export interface ExternalBulkPreviewRepository {
  create(data: ExternalBulkPreviewCreateData): Promise<ExternalBulkPreview>;
  findById(id: string): Promise<ExternalBulkPreview | null>;
  /**
   * D3.b/D8 — ganador de la carrera: `updateMany({where:{id, consumedAt:null},
   * data:{consumedAt, campaignId}})` → `true` SOLO si esta llamada fue la que
   * puso `consumedAt` (count===1). `false` = otra llamada ya lo había consumido.
   */
  markConsumed(id: string, campaignId: string): Promise<boolean>;
  /**
   * D9 — purga best-effort acotada (TTL lazy + purga oportunista). Borra
   * previews con `expiresAt < before`, hasta `limit` filas. Devuelve cuántas
   * se borraron.
   */
  deleteExpiredBefore(before: Date, limit: number): Promise<number>;
}
