/**
 * external-bulk-messaging (D5, actualizado con variables por-recipient VAL-10/
 * D4.e) — hash canónico del payload de un lote externo. Pura, total, sin deps
 * de infra. Anti-replay: el `send` re-calcula este hash desde el preview
 * PERSISTIDO (recipients con las variables YA MERGEADAS) y lo compara contra
 * `payloadHash` — un mismatch (preview mutado en la DB entre `validate` y
 * `send`) tira `PreviewPayloadMismatchError` (SEND-3). Que las variables
 * por-recipient entren al hash es lo que impide el ataque más barato de esta
 * feature: validar un lote inocuo, ver el preview aprobado, y mutar los datos
 * personales antes del `send` (D5).
 */
import { createHash } from 'crypto';
import { normalizePhone } from '@application/use-cases/recapture/matchActiveClient';

export interface ExternalBulkPayloadHashRecipient {
  phone: string;
  /** Cosmético — NO entra al hash (cambiarlo no debe invalidar un preview). */
  name?: string;
  variables?: Record<string, string>;
}

export interface ExternalBulkPayloadHashInput {
  templateName: string;
  variables: Record<string, string>;
  chatwootLabel: string | null | undefined;
  recipients: ExternalBulkPayloadHashRecipient[];
}

const sortedPairs = (v: Record<string, string> | undefined): [string, string][] =>
  Object.keys(v ?? {})
    .sort()
    .map((k) => [k, String((v ?? {})[k])]);

export function externalBulkPayloadHash(p: ExternalBulkPayloadHashInput): string {
  const canonical = JSON.stringify({
    templateName: p.templateName.trim(),
    // claves ORDENADAS: JSON.stringify no garantiza orden estable entre objetos.
    variables: sortedPairs(p.variables),
    chatwootLabel: p.chatwootLabel ?? null,
    // Un recipient ya NO es un string: es [telefono, variables]. El teléfono va
    // NORMALIZADO (normalizePhone) — el mismo lote en otro formato es el MISMO
    // lote; los inválidos (normalize→null) entran como el crudo trimeado, para
    // que cambiar un número roto igual mueva el hash. Las variables van con
    // KEYS ORDENADAS. Se ordena por el par serializado COMPLETO: dos entradas
    // del mismo teléfono con variables distintas no pueden colapsar. `name`
    // NO entra (es cosmético: no cambia ni el destino ni el texto enviado —
    // cambiarlo no debe invalidar un preview).
    recipients: p.recipients
      .map((r) => [normalizePhone(r.phone) ?? r.phone.trim(), sortedPairs(r.variables)] as const)
      .map((pair) => JSON.stringify(pair))
      .sort(),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
