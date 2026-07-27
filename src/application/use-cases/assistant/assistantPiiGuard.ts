import { AssistantPiiLeakError } from '@domain/errors/assistant';

/**
 * ai-assistant-multiagent (SEC-1 / CONV-5) — la barrera de PII antes de que algo salga hacia
 * el modelo.
 *
 * Contexto de por qué esto existe: la API de DeepSeek procesa en servidores en China, y el
 * Art. 12 de la Ley 25.326 prohíbe transferir datos personales a países sin nivel adecuado de
 * protección. Si no viaja dato personal, el Art. 12 no se activa. Esta es la pieza que lo
 * garantiza, y por eso NO es configurable desde la UI (proposal R5).
 *
 * Dos mecanismos, deliberadamente distintos en fuerza:
 *  - `redactPii` sobre el TEXTO libre del cliente: **best-effort y documentado como tal**.
 *  - `assertFactsArePiiFree` sobre los HECHOS que arman los resolvers: **barrera dura**.
 */

const REDACTED = '[dato removido]';

/**
 * Patrones de PII estructurada en texto libre. Deliberadamente CONSERVADORES: preferimos
 * dejar pasar un caso raro antes que redactar un monto o una fecha, porque romper el dato que
 * el bot necesita citar convierte una respuesta útil en un handoff.
 *
 * ⚠️ Ninguno de estos toca números de 4-6 dígitos: ahí viven los montos (`45000`) y los años.
 */
const PII_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  // CUIT/CUIL: 20-20123456-3 (con o sin guiones). Va PRIMERO — si no, el patrón de DNI le
  // comería el bloque del medio y dejaría los extremos sueltos.
  { label: 'cuit', re: /\b\d{2}[-\s]?\d{7,8}[-\s]?\d\b/g },
  // Email.
  { label: 'email', re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
  // DNI: 7-8 dígitos, con o sin puntos de miles. NO matchea 5-6 dígitos (montos).
  { label: 'dni', re: /\b\d{1,3}\.\d{3}\.\d{3}\b|\b\d{7,8}\b/g },
];

/**
 * Redacta PII estructurada de un texto libre del cliente.
 *
 * **Limitación documentada, no escondida:** el mensaje entrante es texto libre y la cobertura
 * NO es total. Un cliente que escriba "mi documento es veinte millones ciento veintitrés mil"
 * pasa. Lo que sí se controla al 100% es no AGREGAR datos de nuestra base — de eso se ocupa
 * `assertFactsArePiiFree`.
 */
export function redactPii(text: string | null | undefined): string {
  if (!text) return '';

  let out = text;
  for (const { re } of PII_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

/**
 * Claves que NUNCA pueden aparecer en los hechos, en ningún nivel de anidación.
 *
 * El escenario real que ataja: un resolver futuro hace `{...clientSummary}` sobre el agregado
 * rico del inbox (que SÍ trae `name`/`email`/`phone`) y la identidad se va al modelo sin que
 * nadie lo note en el code review.
 */
const FORBIDDEN_KEYS = new Set([
  'name',
  'nombre',
  'apellido',
  'fullname',
  'email',
  'mail',
  'phone',
  'telefono',
  'celular',
  'dni',
  'documento',
  'cuit',
  'cuil',
  'direccion',
  'domicilio',
  'address',
  'contactname',
  'contactphone',
]);

/**
 * Longitud mínima para tratar un valor prohibido como buscable dentro de otro texto. Un
 * cliente llamado "Ana" no puede hacer que la palabra "avanzado" dispare una fuga.
 */
const MIN_FORBIDDEN_VALUE_LENGTH = 5;

/**
 * SEC-1 — **barrera dura**. Lanza si los hechos contienen identidad del cliente, ya sea por
 * el nombre de la clave o porque el valor coincide con un dato de identidad real.
 *
 * @param facts          objeto de hechos ya armado por los resolvers
 * @param forbiddenValues valores de identidad REALES del cliente (nombre, email, teléfono,
 *                        documento), resueltos localmente. Nunca viajan; sólo se usan acá
 *                        para comparar.
 *
 * A diferencia de `redactPii`, esto NO sanea: **lanza**. Un hecho contaminado no se limpia y
 * se manda igual — se corta. El motor lo atrapa y degrada a no-op (RUN-1).
 */
export function assertFactsArePiiFree(facts: unknown, forbiddenValues: string[]): void {
  const offending: string[] = [];
  const needles = forbiddenValues
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v.length >= MIN_FORBIDDEN_VALUE_LENGTH);

  const walk = (node: unknown, path: string): void => {
    if (node === null || node === undefined) return;

    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }

    if (typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        const here = path ? `${path}.${key}` : key;
        if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
          offending.push(here);
          continue; // ya está reportado; no hace falta bajar
        }
        walk(value, here);
      }
      return;
    }

    if (typeof node === 'string' && needles.length > 0) {
      const haystack = node.trim().toLowerCase();
      if (needles.some((n) => haystack.includes(n))) {
        offending.push(path);
      }
    }
  };

  walk(facts, '');

  if (offending.length > 0) {
    // Se pasan las RUTAS, jamás los valores: loguear el dato filtrado para avisar de la fuga
    // sería el mismo problema en otro archivo.
    throw new AssistantPiiLeakError(offending);
  }
}
