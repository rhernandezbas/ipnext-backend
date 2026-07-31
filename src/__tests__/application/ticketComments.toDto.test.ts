/**
 * toTicketCommentDto — G11 (fix wave FINAL, LOW).
 *
 * Dos hallazgos sobre el mapeo de adjuntos:
 *
 * 1. `commentId` se dropeaba del DTO — verificado contra el FE real
 *    (`ipnext-frontend/src/types/ticketComments.ts`,
 *    `TicketCommentAttachment.commentId: string`, campo REQUERIDO en el
 *    modelo de lectura): el FE espera este campo. Se preserva.
 * 2. `url: a.url ?? ''` — un adjunto legacy CORRUPTO (sin `storageKey` Y sin
 *    `url`, un estado que no debería existir pero que el tipo del dominio no
 *    prohíbe) se mapeaba a `url: ''`, que en el FE renderiza `<img src="">`
 *    — un string vacío en `src` hace que algunos navegadores reinterpreten
 *    la URL como "la página actual" (recarga/comportamiento sorpresa), no
 *    "sin imagen". `null` es honesto: "no hay URL", y el FE puede chequearlo
 *    explícitamente.
 */
import { toTicketCommentDto } from '@application/dto/ticketComments.dto';
import { TicketComment } from '@domain/entities/ticketComment';

function baseComment(overrides: Partial<TicketComment> = {}): TicketComment {
  return {
    id: 'c1',
    ticketId: 't1',
    authorId: 'acc-1',
    authorKind: 'staff',
    visibility: 'internal',
    authorName: 'Ana',
    body: 'hola',
    createdAt: '2026-01-01T00:00:00.000Z',
    attachments: [],
    ...overrides,
  };
}

describe('toTicketCommentDto — G11', () => {
  it('preserva commentId en cada adjunto — revert-probe: dropearlo de nuevo pone este test en rojo', () => {
    const comment = baseComment({
      attachments: [
        { id: 'a1', commentId: 'c1', url: null, storageKey: 'tickets/t1/c1/a1.jpg', kind: 'image', filename: 'foto.jpg', mimeType: 'image/jpeg', sizeBytes: 100 },
      ],
    });

    const dto = toTicketCommentDto(comment);

    expect(dto.attachments[0]).toMatchObject({ commentId: 'c1' });
  });

  it('un adjunto legacy CORRUPTO (sin storageKey Y sin url) mapea a url:null, NUNCA url:"" — revert-probe: volver a `?? \'\'` pone este test en rojo', () => {
    const comment = baseComment({
      attachments: [
        { id: 'a-corrupt', commentId: 'c1', url: null, storageKey: null, kind: null, filename: 'x.png', mimeType: 'image/png', sizeBytes: 3 },
      ],
    });

    const dto = toTicketCommentDto(comment);

    expect(dto.attachments[0]!.url).toBeNull();
  });

  it('un adjunto legacy NORMAL (con url data-URI) sigue mapeando su url tal cual — no regresión', () => {
    const comment = baseComment({
      attachments: [
        { id: 'a-legacy', commentId: 'c1', url: 'data:image/png;base64,AAAA', storageKey: null, kind: null, filename: 'legacy.png', mimeType: 'image/png', sizeBytes: 3 },
      ],
    });

    const dto = toTicketCommentDto(comment);

    expect(dto.attachments[0]!.url).toBe('data:image/png;base64,AAAA');
  });

  it('un adjunto de la mensajería nueva (storageKey) sigue resolviendo la ruta del BE-proxy — no regresión', () => {
    const comment = baseComment({
      attachments: [
        { id: 'a-new', commentId: 'c1', url: null, storageKey: 'tickets/t1/c1/a-new.jpg', kind: 'image', filename: 'foto.jpg', mimeType: 'image/jpeg', sizeBytes: 100 },
      ],
    });

    const dto = toTicketCommentDto(comment);

    expect(dto.attachments[0]!.url).toBe('/api/tickets/messages/attachments/a-new/file');
  });
});
