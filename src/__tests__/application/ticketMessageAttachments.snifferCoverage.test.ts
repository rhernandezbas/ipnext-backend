/**
 * ticketMessageAttachments — G8 (fix wave FINAL, LOW).
 *
 * `classify()` acepta un mimeType si está en alguna de las tres allowlists
 * (`IMAGE/AUDIO/VIDEO_MIME_TO_EXT`), pero `matchesMagicBytes` (F4) exige
 * ADEMÁS una entrada en `MAGIC_BYTE_SNIFFERS` para ese mismo mimeType — si
 * alguien agrega un tipo a la allowlist y se olvida del sniffer, HOY el
 * resultado es un 415 "tipo no soportado" SILENCIOSO para un archivo
 * legítimo (matchesMagicBytes devuelve `false` porque `MAGIC_BYTE_SNIFFERS[mimeType]`
 * es `undefined`) — nada en la suite se pone rojo para avisar. Este test
 * convierte ese silencio en una falla explícita AL AGREGAR el tipo, no en
 * producción cuando un cliente intenta subir un archivo real.
 */
import {
  IMAGE_MIME_TO_EXT,
  AUDIO_MIME_TO_EXT,
  VIDEO_MIME_TO_EXT,
  MAGIC_BYTE_SNIFFERS,
} from '@application/use-cases/ticketMessageAttachments';

describe('MAGIC_BYTE_SNIFFERS — cobertura completa de la allowlist (G8)', () => {
  it('TODO mimeType de las tres allowlists (imagen/audio/video) tiene su propio sniffer — revert-probe: sacar una entrada de MAGIC_BYTE_SNIFFERS pone este test en rojo', () => {
    const allowlist = [
      ...Object.keys(IMAGE_MIME_TO_EXT),
      ...Object.keys(AUDIO_MIME_TO_EXT),
      ...Object.keys(VIDEO_MIME_TO_EXT),
    ];
    const sniffed = new Set(Object.keys(MAGIC_BYTE_SNIFFERS));

    const missing = allowlist.filter((mime) => !sniffed.has(mime));

    expect(missing).toEqual([]);
  });

  it('el mapa de sniffers no sniffea tipos FUERA de la allowlist (evita basura acumulada sin uso real)', () => {
    const allowlist = new Set([
      ...Object.keys(IMAGE_MIME_TO_EXT),
      ...Object.keys(AUDIO_MIME_TO_EXT),
      ...Object.keys(VIDEO_MIME_TO_EXT),
    ]);
    const extraneous = Object.keys(MAGIC_BYTE_SNIFFERS).filter((mime) => !allowlist.has(mime));

    expect(extraneous).toEqual([]);
  });
});
