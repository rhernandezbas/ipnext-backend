/**
 * ai-assistant-multiagent (SEC-4, design D3) — verificador de números.
 *
 * Convierte una alucinación sobre plata en un handoff. Puramente sintáctico y SIN modelo: se
 * arma un whitelist de cifras respaldadas y se rechaza toda secuencia de 3+ dígitos de la
 * salida que no esté ahí.
 *
 * ⚠️ **La asimetría cliente/bot es la regla más importante de este archivo.** El whitelist
 * incluye lo que escribió EL CLIENTE, pero NUNCA lo que dijo el bot en turnos anteriores.
 * Si el bot alucinó "$54.000" en el turno 2, ese texto queda en el hilo; si el whitelist
 * tomara los mensajes del bot, en el turno 5 lo encontraría "en el historial" y lo aprobaría.
 * El error se LAVA: pasa a ser verdad por repetición, y encima con el sello del verificador.
 *
 * Por eso `NumberWhitelistSources` sólo declara `customerMessages`: los mensajes del bot ni
 * siquiera se le pueden pasar por accidente.
 */

export interface NumberWhitelistSources {
  /** Hechos inyectados en ESTE turno. En modo CONVERSAR va `{}` ⇒ ninguna cifra es válida. */
  facts: unknown;
  /** `persona`, `responseGuide`, `handoffMessage` — ahí viven "24 horas", el 0800, etc. */
  profileTexts: string[];
  /** SÓLO lo que escribió el cliente. Los turnos del bot NO entran (ver asimetría arriba). */
  customerMessages: string[];
}

/** Mínimo de dígitos para considerar una cifra. 1-2 es ruido: "2 días", "el 5 de agosto". */
const MIN_DIGITS = 3;

/** Marcadores de magnitud en letras — la limitación conocida de este verificador. */
const MAGNITUDE_WORDS = ['mil', 'millon', 'millón', 'millones'];

/**
 * Normaliza separadores de miles ANTES de extraer: `45.000` y `45,000` deben leerse como
 * `45000`, no como `45` + `000`. Sólo colapsa el separador cuando le siguen exactamente 3
 * dígitos, para no comerse un decimal (`1.5`) ni una fecha (`10/08`).
 */
function normalize(text: string): string {
  return text.replace(/(\d)[.,](?=\d{3}(?!\d))/g, '$1');
}

/** Extrae las secuencias de `MIN_DIGITS`+ dígitos de un texto ya normalizado. */
function extractNumbers(text: string): string[] {
  return normalize(text).match(new RegExp(`\\d{${MIN_DIGITS},}`, 'g')) ?? [];
}

/** Recorre cualquier estructura y junta los números de sus valores primitivos. */
function collectFromValue(node: unknown, out: Set<string>): void {
  if (node === null || node === undefined) return;

  if (typeof node === 'number') {
    // `String(45000)` = "45000". Los decimales aportan sus dos partes por separado, que es
    // lo correcto: el modelo puede escribir "1500,50" o "1500.50" y ambas se respaldan.
    for (const n of extractNumbers(String(node))) out.add(n);
    return;
  }
  if (typeof node === 'string') {
    for (const n of extractNumbers(node)) out.add(n);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectFromValue(item, out);
    return;
  }
  if (typeof node === 'object') {
    for (const value of Object.values(node as Record<string, unknown>)) {
      collectFromValue(value, out);
    }
  }
}

/**
 * Construye el conjunto de cifras que el modelo TIENE derecho a escribir.
 *
 * En modo CONVERSAR los hechos van vacíos, así que el whitelist queda casi vacío y la regla
 * se vuelve absoluta: cualquier cifra inventada durante una charla se descarta, sin necesidad
 * de razonar cuál sería válida (CONV-3).
 */
export function buildNumberWhitelist(sources: NumberWhitelistSources): Set<string> {
  const whitelist = new Set<string>();

  collectFromValue(sources.facts, whitelist);
  for (const text of sources.profileTexts) collectFromValue(text, whitelist);
  for (const text of sources.customerMessages) collectFromValue(text, whitelist);

  return whitelist;
}

/**
 * Devuelve las cifras de `output` que NO están respaldadas. Vacío = la salida se puede enviar.
 *
 * También reporta un marcador de magnitud en letras ("mil", "millones") cuando aparece SIN
 * ningún dígito respaldado en la salida: es la mitigación parcial de la limitación conocida
 * —"cuarenta y cinco mil" escapa a la extracción de dígitos— y está documentada como red
 * incompleta, no como garantía.
 */
export function findUnbackedNumbers(output: string, whitelist: Set<string>): string[] {
  const unbacked = new Set<string>();

  for (const found of extractNumbers(output)) {
    if (!whitelist.has(found)) unbacked.add(found);
  }

  // Magnitud en letras sin ninguna cifra respaldada que la acompañe.
  const lower = output.toLowerCase();
  const hasBackedDigits = extractNumbers(output).some((n) => whitelist.has(n));
  if (!hasBackedDigits) {
    for (const word of MAGNITUDE_WORDS) {
      if (new RegExp(`\\b${word}\\b`).test(lower)) {
        unbacked.add('mil');
        break;
      }
    }
  }

  return [...unbacked];
}
