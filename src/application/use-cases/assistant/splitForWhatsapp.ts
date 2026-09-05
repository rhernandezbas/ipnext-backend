/**
 * ai-assistant-cobranzas (3.1 / D3 / REN-2) — split determinístico del mensaje final
 * (texto redactado + bloque de facturas anexado) en trozos ≤ `cap` caracteres.
 *
 * Función PURA: sin repos, sin modelo. `cap` por defecto es 1.400 — margen bajo el límite
 * duro de Twilio (1.600) que deja lugar al prefijo de numeración `(i/N)` SIN arriesgar el
 * límite real. `executeAction` itera los chunks secuencialmente sobre el mismo
 * `reply`/`privateNote` existente (el puerto no cambia, D3).
 *
 * Reglas de corte, en orden de preferencia: `\n\n` (párrafo) > `\n` (línea) > espacio.
 * NUNCA corta a mitad de una URL — un candidato de corte que caiga dentro de una URL se
 * descarta y se busca el candidato anterior.
 */

const DEFAULT_CAP = 1400;

/** Detecta URLs para que ningún punto de corte caiga en su interior. */
const URL_PATTERN = /https?:\/\/\S+/g;

interface UrlSpan {
  start: number;
  end: number;
}

function findUrlSpans(text: string): UrlSpan[] {
  const spans: UrlSpan[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    spans.push({ start, end: start + match[0].length });
  }
  return spans;
}

/** `true` si `index` cae ESTRICTAMENTE dentro de alguna URL (no en sus bordes). */
function isInsideUrl(index: number, spans: UrlSpan[]): boolean {
  return spans.some((s) => index > s.start && index < s.end);
}

/**
 * Busca el mejor punto de corte en `text.slice(0, limit)`, en orden de preferencia
 * `\n\n` > `\n` > espacio, evitando SIEMPRE partir una URL. Si ningún separador sirve
 * (una sola palabra/URL larguísima), corta duro en `limit` — nunca deja crecer el chunk
 * más allá del cap.
 */
function findCutPoint(text: string, limit: number, spans: UrlSpan[]): number {
  const window = text.slice(0, limit);

  for (const separator of ['\n\n', '\n', ' ']) {
    let idx = window.lastIndexOf(separator);
    while (idx > 0) {
      if (!isInsideUrl(idx, spans)) {
        return idx + separator.length;
      }
      idx = window.lastIndexOf(separator, idx - 1);
    }
  }

  // Sin separador utilizable: corte duro, salvo que eso parta una URL — en ese caso
  // retrocedemos hasta el inicio de la URL para no cortarla, aunque el chunk quede más chico.
  if (isInsideUrl(limit, spans)) {
    const url = spans.find((s) => limit > s.start && limit < s.end);
    // ⚠️ fix wave C2 — `url.start === 0` (el trozo ARRANCA con una URL más larga que el cap)
    // devolvía 0: el chunk salía vacío, `rest` no encogía y el `while` de `rawSplit` giraba
    // para siempre. Es código SÍNCRONO en el camino del webhook: colgaba el event loop de
    // TODO el backend. Una URL que no entra en el cap no se puede preservar entera —
    // partirla es el mal menor frente a colgar el proceso.
    if (url && url.start > 0) return url.start;
  }
  return limit;
}

/** Parte `text` en trozos ≤ `cap`, sin numerar todavía (paso previo a `splitForWhatsapp`). */
function rawSplit(text: string, cap: number): string[] {
  if (text.length <= cap) return [text];

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > cap) {
    // Segunda red del fix wave C2: pase lo que pase, el corte AVANZA. Un `cut <= 0` (o mayor
    // que lo que queda) sería un chunk vacío y un loop infinito.
    let cut = findCutPoint(rest, cap, findUrlSpans(rest));
    if (cut <= 0 || cut > rest.length) cut = cap;
    const piece = rest.slice(0, cut);
    // El separador que decidió el corte (\n\n, \n o espacio) queda DESCARTADO — es puntuación
    // de layout, no contenido; dejarlo colgando al final del chunk sería un salto de línea
    // huérfano justo antes del prefijo `(i/N)` del chunk siguiente.
    chunks.push(piece.replace(/\s+$/, ''));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest.replace(/\s+$/, ''));

  // Un trozo que era SÓLO whitespace queda vacío tras el trim: mandarlo sería un mensaje en
  // blanco al cliente (y un número de chunk gastado).
  return chunks.filter((c) => c.length > 0);
}

/** Longitud del prefijo `(i/N) ` para `total` chunks (mismo ancho de dígitos para todo i ≤ total). */
function prefixLength(total: number): number {
  return `(${total}/${total}) `.length;
}

/**
 * Parte `text` en trozos ≤ `cap` caracteres, numerados `(i/N)` cuando hay más de uno. El
 * prefijo se reserva DENTRO del cap desde el primer corte (no se trunca contenido después):
 * se hace un primer pase para estimar cuántos chunks van a hacer falta, y un segundo pase
 * que corta con `cap - prefixLength` para que el prefijo entre siempre. El corte preferido
 * es `\n\n` > `\n` > espacio, y NUNCA cae a mitad de una URL.
 */
export function splitForWhatsapp(text: string, cap: number = DEFAULT_CAP): string[] {
  const estimate = rawSplit(text, cap);
  if (estimate.length <= 1) return [text];

  // ⚠️ fix wave W4 — el ancho del prefijo depende de CUÁNTOS chunks salgan, y cuántos salgan
  // depende del ancho. Un solo pase con el ancho de la ESTIMACIÓN deja pasar chunks de
  // `cap + 2` cuando el pase final cruza de 9 a 10 trozos (`(9/9) ` mide 6, `(10/10) ` mide
  // 8). Se itera hasta que el ancho se estabiliza — converge en una o dos vueltas.
  let width = prefixLength(estimate.length);
  let rawChunks = rawSplit(text, Math.max(1, cap - width));
  for (let intento = 0; intento < 5 && prefixLength(rawChunks.length) !== width; intento++) {
    width = prefixLength(rawChunks.length);
    rawChunks = rawSplit(text, Math.max(1, cap - width));
  }

  const total = rawChunks.length;
  return rawChunks.map((piece, i) => `(${i + 1}/${total}) ${piece}`);
}
