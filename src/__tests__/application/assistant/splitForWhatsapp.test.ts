import { splitForWhatsapp } from '@application/use-cases/assistant/splitForWhatsapp';

/**
 * ai-assistant-cobranzas (3.1 / REN-2) — split determinístico ≤1.400 caracteres.
 *
 * Función pura: sin repos, sin modelo. El margen (1.400 vs. el límite duro de Twilio 1.600)
 * absorbe el prefijo de numeración `(i/N)` sin arriesgar el límite real.
 */

function invoiceLine(n: number): string {
  return `Factura ${n}: vencimiento 10/09/2026, saldo pendiente $12.345,67. ${'x'.repeat(200)}\n\n`;
}

describe('splitForWhatsapp', () => {
  it('un texto corto no se parte y no lleva numeración', () => {
    const text = 'Hola, ¿en qué te puedo ayudar?';

    expect(splitForWhatsapp(text)).toEqual([text]);
  });

  it('REN-2: 6 facturas producen 2 chunks numerados, cada uno ≤1.400', () => {
    const text = Array.from({ length: 6 }, (_, i) => invoiceLine(i + 1)).join('');
    // Confirma la premisa del escenario: supera 1.400 pero no 2.800.
    expect(text.length).toBeGreaterThan(1400);
    expect(text.length).toBeLessThan(2800);

    const chunks = splitForWhatsapp(text);

    expect(chunks).toHaveLength(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1400);
    }
    expect(chunks[0]).toMatch(/^\(1\/2\)/);
    expect(chunks[1]).toMatch(/^\(2\/2\)/);
  });

  it('REN-2: el prefijo de numeración queda DENTRO del cap, no lo excede', () => {
    const text = Array.from({ length: 6 }, (_, i) => invoiceLine(i + 1)).join('');

    const chunks = splitForWhatsapp(text, 1400);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1400);
    }
  });

  it('REN-2: el corte preferido es \\n\\n antes que \\n o un espacio', () => {
    // Dos párrafos separados por \n\n; un solo salto simple dentro de cada uno. El corte debe
    // caer en el \n\n, no partir un párrafo por la mitad si el \n\n cae dentro de la ventana.
    const paragraph = 'x'.repeat(600);
    const text = `${paragraph}\n\n${paragraph}\n${paragraph}`;

    const chunks = splitForWhatsapp(text, 650);

    // El primer chunk termina justo en el primer párrafo (cortó en \n\n, no a mitad del 2do).
    expect(chunks[0].replace(/^\(\d+\/\d+\)\s*/, '')).toBe(paragraph);
  });

  it('REN-2: nunca corta una URL a la mitad', () => {
    const url = 'https://gestionreal.example.com/pagar/muy-largo-token-de-pago-1234567890abcdef';
    const filler = 'y'.repeat(1380);
    const text = `${filler} ${url}`;

    const chunks = splitForWhatsapp(text, 1400);

    const rebuilt = chunks.map((c) => c.replace(/^\(\d+\/\d+\)\s*/, '')).join('');
    expect(rebuilt).toContain(url);
    // La URL completa aparece INTACTA en algún chunk (nunca partida en dos).
    expect(chunks.some((c) => c.includes(url))).toBe(true);
  });

  it('el orden de los chunks se preserva (whitespace-insensitive: el separador de corte se descarta)', () => {
    const text = Array.from({ length: 6 }, (_, i) => invoiceLine(i + 1)).join('');

    const chunks = splitForWhatsapp(text);
    const rebuilt = chunks.map((c) => c.replace(/^\(\d+\/\d+\)\s*/, '')).join(' ');

    expect(rebuilt.replace(/\s+/g, ' ').trim()).toBe(text.replace(/\s+/g, ' ').trim());
  });

  it('un texto que entra justo en un cap MUY chico no numera si entra en 1 solo chunk', () => {
    expect(splitForWhatsapp('hola', 10)).toEqual(['hola']);
  });

  // ── Fix wave (C2/W4) ──────────────────────────────────────────────────────
  it('C2: una URL MÁS LARGA que el cap no cuelga el proceso (loop infinito)', () => {
    // El fixture del test de arriba (URL de ~80 chars contra un cap de 1.400) no discrimina:
    // el bug vive cuando `rest` ARRANCA con una URL que no entra en el cap, porque el punto
    // de corte retrocede a `url.start === 0` y `rest` deja de encoger. Es código SÍNCRONO en
    // el camino del webhook: colgaba el event loop de todo el backend.
    const url = 'https://gestionreal.example.com/pagar/' + 'a'.repeat(2000);
    expect(url.length).toBeGreaterThan(1400);
    const text = ['Pagá acá:', url, 'gracias'].join('\n\n');

    const chunks = splitForWhatsapp(text, 1400);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1400);
    // Nada se pierde: la URL se corta duro (no hay forma de que entre), pero el texto se
    // reconstruye completo.
    const rebuilt = chunks.map((c) => c.replace(/^\(\d+\/\d+\)\s*/, '')).join('');
    expect(rebuilt.replace(/\s+/g, '')).toContain(url.slice(0, 500));
    expect(chunks.every((c) => c.length > 0)).toBe(true);
  });

  it('C2: un texto que es SÓLO una URL gigante tampoco cuelga', () => {
    const url = 'https://mp.example/x/' + 'b'.repeat(4000);

    const chunks = splitForWhatsapp(url, 1400);

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1400);
  });

  it('W4: NINGÚN chunk supera el cap, aunque el ancho del prefijo cambie de 9 a 10 chunks', () => {
    // El prefijo `(9/9) ` mide 6 y `(10/10) ` mide 8: si el pase final produce más chunks que
    // la estimación, el `effectiveCap` calculado con el ancho viejo deja pasar chunks de
    // `cap + 2`. Property-style sobre varios largos para cruzar el borde de los dos dígitos.
    for (const largo of [1500, 4000, 9000, 13000, 14000, 20000, 30000]) {
      const text = Array.from({ length: Math.ceil(largo / 60) }, (_, i) => `linea ${i} ${'z'.repeat(50)}`).join('\n');
      const chunks = splitForWhatsapp(text, 1400);
      for (const chunk of chunks) {
        // El `largo` viaja en el mensaje del assert: si falla, se sabe cuál de los tamaños fue.
        expect({ largo, ok: chunk.length <= 1400 }).toEqual({ largo, ok: true });
      }
    }
  });
});
