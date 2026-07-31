/**
 * ticketMessageAttachments — validateTicketMessageFilesBatch. portal-ticket-
 * messaging (v2.B) fix wave, F4 (MEDIUM).
 *
 * Antes del fix, `classify()` solo miraba el `mimeType` DECLARADO por el
 * cliente (el `Content-Type` de la parte multipart) — un ejecutable PE
 * (`MZ...`) con `filename: payload.jpg` + `Content-Type: image/jpeg` pasaba
 * la validación y quedaba guardado en MinIO con 201. El fix agrega sniffing
 * de magic bytes del CONTENIDO REAL para cada formato permitido y rechaza si
 * no coincide con lo declarado — mismo código de error (415) que un tipo no
 * soportado, pero ahora también cubre el disfraz.
 *
 * Revert-probe (HIGH del reporte, aplicado acá): comentar el chequeo de
 * magic bytes hace que el test "ejecutable disfrazado" vuelva a pasar.
 */
import { validateTicketMessageFilesBatch, TicketMessageFile } from '@application/use-cases/ticketMessageAttachments';
import { UnsupportedTicketMessageAttachmentTypeError } from '@domain/errors/ticketMessage';

function file(overrides: Partial<TicketMessageFile>): TicketMessageFile {
  return { buffer: Buffer.from([]), originalName: 'f', mimeType: 'image/jpeg', ...overrides };
}

// Magic bytes REALES de cada formato permitido (documentados en ticketMessageAttachments.ts).
const REAL_BYTES: Record<string, Buffer> = {
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/gif': Buffer.from('GIF89a', 'ascii'),
  'image/webp': Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP', 'ascii')]),
  'audio/mpeg': Buffer.from([0x49, 0x44, 0x33, 0x03]), // ID3
  'audio/mp4': Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp', 'ascii'), Buffer.from('M4A ', 'ascii')]),
  'audio/x-m4a': Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp', 'ascii'), Buffer.from('M4A ', 'ascii')]),
  'audio/aac': Buffer.from([0xff, 0xf1, 0x50, 0x80]),
  'audio/ogg': Buffer.from('OggS', 'ascii'),
  'audio/wav': Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVE', 'ascii')]),
  'audio/x-wav': Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVE', 'ascii')]),
  'audio/webm': Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  'video/mp4': Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp', 'ascii'), Buffer.from('isom', 'ascii')]),
  'video/quicktime': Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftyp', 'ascii'), Buffer.from('qt  ', 'ascii')]),
  'video/webm': Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  'video/3gpp': Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp', 'ascii'), Buffer.from('3gp4', 'ascii')]),
};

const EXECUTABLE_BYTES = Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00', 'binary');

describe('validateTicketMessageFilesBatch — F4 (fix wave): magic bytes del contenido real', () => {
  it('el ejecutable renombrado a .jpg con Content-Type image/jpeg es RECHAZADO (415), no solo el mimeType declarado', () => {
    const f = file({ buffer: EXECUTABLE_BYTES, originalName: 'payload.jpg', mimeType: 'image/jpeg' });

    expect(() => validateTicketMessageFilesBatch([f])).toThrow(UnsupportedTicketMessageAttachmentTypeError);
  });

  it.each(Object.keys(REAL_BYTES))('%s: bytes reales del formato -> PASA', (mimeType) => {
    const f = file({ buffer: REAL_BYTES[mimeType]!, mimeType });

    expect(() => validateTicketMessageFilesBatch([f])).not.toThrow();
  });

  it.each(Object.keys(REAL_BYTES))('%s: mimeType declarado correcto pero bytes de OTRO formato -> RECHAZADO (415)', (mimeType) => {
    const wrongBytes = mimeType === 'image/jpeg' ? REAL_BYTES['image/png']! : REAL_BYTES['image/jpeg']!;
    const f = file({ buffer: wrongBytes, mimeType });

    expect(() => validateTicketMessageFilesBatch([f])).toThrow(UnsupportedTicketMessageAttachmentTypeError);
  });

  it('buffer vacío sigue siendo 415 "tipo no soportado" (F10, sin cambios — el chequeo de 0 bytes corre primero)', () => {
    const f = file({ buffer: Buffer.from([]), mimeType: 'image/jpeg' });

    expect(() => validateTicketMessageFilesBatch([f])).toThrow(UnsupportedTicketMessageAttachmentTypeError);
  });
});
