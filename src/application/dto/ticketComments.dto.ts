import { z } from 'zod';
import { TicketComment } from '@domain/entities/ticketComment';

// SVG is excluded on purpose: it can carry <script>, so an inline SVG image is a
// stored-XSS vector. We reject `image/svg`, `image/svg+xml`, etc. — in both the
// data-URI mime group and the mimeType whitelist.
const SVG_MIME_RE = /^image\/svg/i;
const DATA_URI_RE = /^data:(image\/(?!svg)[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * portal-ticket-messaging (v2.B) fix wave FINAL, G6 — `.strict()` A PROPÓSITO,
 * hermano ANIDADO de F2 (`AddTicketCommentSchema` de abajo): el `.strict()`
 * del objeto EXTERIOR no alcanza a los objetos anidados dentro de un array —
 * zod valida cada elemento de `attachments` contra ESTE schema, así que sin
 * su propio `.strict()`, un campo desconocido en un attachment individual se
 * strippeaba en silencio en vez de rechazarse. Verificado contra el FE real
 * (`ipnext-frontend/src/types/ticketComments.ts`,
 * `AddTicketCommentInput.attachments`): manda exactamente
 * `{url, filename, mimeType, sizeBytes}` — los mismos cuatro campos que este
 * schema ya exige — así que `.strict()` acá no rompe ningún request legítimo.
 */
export const TicketCommentAttachmentSchema = z
  .object({
    url: z.string().regex(DATA_URI_RE),
    filename: z.string().min(1),
    mimeType: z.string().regex(/^image\//).refine((m) => !SVG_MIME_RE.test(m), {
      message: 'SVG images are not allowed',
    }),
    sizeBytes: z.number().int().positive(),
  })
  .strict()
  .superRefine((a, ctx) => {
    const m = DATA_URI_RE.exec(a.url);
    if (!m) return;
    const [, mime, b64] = m;
    const real =
      Math.floor((b64!.length * 3) / 4) -
      (b64!.endsWith('==') ? 2 : b64!.endsWith('=') ? 1 : 0);
    if (real > MAX_IMAGE_BYTES) ctx.addIssue({ code: 'custom', message: 'image exceeds 2MB' });
    if (real !== a.sizeBytes) ctx.addIssue({ code: 'custom', message: 'sizeBytes mismatch' });
    if (a.mimeType !== mime) ctx.addIssue({ code: 'custom', message: 'mimeType mismatch' });
  });

/**
 * portal-ticket-messaging (v2.B) fix wave, F2 — `.strict()` A PROPÓSITO, mismo
 * criterio que `SendStaffTicketReplySchema` / `SendPortalTicketMessageSchema`:
 * esta ruta (`POST /api/tickets/:ticketId/comments`) es el camino de las NOTAS
 * INTERNAS de siempre (`AddTicketComment` estampa `authorKind: 'staff'` +
 * `visibility: 'internal'` FIJOS, ver ese use case) — `visibility`/`authorKind`
 * NUNCA viajan como parámetro del input. Antes de `.strict()`, zod los
 * STRIPPEABA en silencio: `{body, visibility:'public', authorKind:'client'}`
 * daba 201 con el comentario quedando `internal` igual — el resultado era
 * seguro, pero un caller que creyera estar mandando un mensaje público al
 * cliente nunca se enteraba de que no pasó nada. Ahora cualquier campo fuera
 * del schema (este incluido) rechaza con 422/VALIDATION_ERROR — el mismo
 * contrato que esta ruta ya usa para el resto de sus validaciones.
 */
export const AddTicketCommentSchema = z
  .object({
    body: z.string().default(''),
    authorName: z.string().min(1).optional(),
    attachments: z.array(TicketCommentAttachmentSchema).max(3).default([]),
  })
  .strict()
  .refine((d) => d.body.trim().length > 0 || d.attachments.length > 0);

export type AddTicketCommentDto = z.infer<typeof AddTicketCommentSchema>;

/**
 * F9 (fix wave) — DTO de salida de `ticketComments.routes.ts` (el CRUD de
 * notas internas de siempre). Antes, la ruta devolvía la ENTIDAD `TicketComment`
 * cruda (`res.json(comment[s])`), que desde v2.B incluye `storageKey` — el
 * layout interno del bucket de MinIO no tiene por qué viajar al cliente.
 *
 * `authorId`/`visibility` SÍ se exponen a propósito (a diferencia del DTO del
 * portal, `portalTicketMessage.dto.ts`): esta ruta es admin-only, y el
 * criterio ya establecido para el equivalente de mensajería
 * (`toTicketMessageDto`, `ticketMessage.dto.ts`) es que el staff ve todo el
 * comentario.
 *
 * `url` por adjunto preserva AMBOS sistemas: los legacy (data-URI en `url`,
 * `storageKey: null`, el único tipo que esta ruta puede CREAR — ver
 * `AddTicketComment`) siguen tal cual; los de la mensajería nueva
 * (`storageKey` no nulo, pueden aparecer acá si conviven en el mismo hilo que
 * un `SendStaffTicketReply`) se sirven por la ruta BE-proxy existente.
 */
export interface TicketCommentDto {
  id: string;
  ticketId: string;
  authorId: string | null;
  authorKind: TicketComment['authorKind'];
  visibility: TicketComment['visibility'];
  authorName: string;
  body: string;
  createdAt: string;
  attachments: Array<{
    id: string;
    kind: 'image' | 'audio' | 'video' | null;
    filename: string;
    mimeType: string | null;
    sizeBytes: number | null;
    url: string;
  }>;
}

export function toTicketCommentDto(comment: TicketComment): TicketCommentDto {
  return {
    id: comment.id,
    ticketId: comment.ticketId,
    authorId: comment.authorId,
    authorKind: comment.authorKind,
    visibility: comment.visibility,
    authorName: comment.authorName,
    body: comment.body,
    createdAt: comment.createdAt,
    attachments: comment.attachments.map((a) => ({
      id: a.id,
      kind: a.kind,
      filename: a.filename,
      mimeType: a.mimeType ?? null,
      sizeBytes: a.sizeBytes ?? null,
      url: a.storageKey != null ? `/api/tickets/messages/attachments/${a.id}/file` : (a.url ?? ''),
    })),
  };
}
