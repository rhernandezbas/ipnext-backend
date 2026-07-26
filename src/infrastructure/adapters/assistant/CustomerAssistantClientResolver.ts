import type { CampaignSegmentSource, CustomerRepository } from '@domain/ports/CustomerRepository';
import type {
  AssistantClientIdentity,
  AssistantClientResolver,
} from '@domain/ports/AssistantClientResolver';
import { toWhatsAppE164 } from '@application/use-cases/messaging/toWhatsAppE164';

const UNKNOWN: AssistantClientIdentity = { clientId: null, optedOut: false, identityValues: [] };

/**
 * ai-assistant-multiagent (SEC-1/SEC-5) — resuelve el cliente por teléfono.
 *
 * ⚠️ **Usa `listSegmentRecipients({statuses: []})`, NO `listActiveContacts()`.** No es un
 * detalle: `listActiveContacts` filtra `status:'active'` y por lo tanto EXCLUYE a los
 * `late`/`blocked`/`baja` — que son exactamente los clientes que más escriben preguntando por
 * su deuda. Un asistente que no reconociera a un moroso fallaría justo en su caso de uso
 * principal. Misma decisión (y mismo motivo) que el opt-out del webhook, documentada allá
 * como "contradicción #4".
 *
 * El match es por **E164 canónico** (`toWhatsAppE164`), no por sufijo ni por `normalizePhone`.
 * Ese camino ya sobrevivió dos olas de fixes: el sufijo producía falsos positivos entre áreas
 * distintas, y `normalizePhone` es lossy con el "15" móvil embebido (falsos negativos). No
 * reimplementar esto acá — reusar el helper endurecido.
 *
 * Si el mismo E164 resuelve a VARIOS clientes (co-titulares), NO se elige uno: se devuelve
 * `clientId: null`. Adivinar cuál es implicaría contarle a una persona el saldo de otra.
 */
export class CustomerAssistantClientResolver implements AssistantClientResolver {
  constructor(
    private readonly segments: CampaignSegmentSource,
    private readonly customers: CustomerRepository,
  ) {}

  async resolveByPhone(phone: string | null): Promise<AssistantClientIdentity> {
    const fromE164 = toWhatsAppE164(phone);
    if (fromE164 === null) return { ...UNKNOWN };

    const candidates = await this.segments.listSegmentRecipients({ statuses: [] });
    const matches = candidates.filter((c) => {
      const candidateE164 = toWhatsAppE164(c.phone);
      return candidateE164 !== null && candidateE164 === fromE164;
    });

    // Ambigüedad ⇒ nadie. Con dos co-titulares en el mismo número, elegir "el primero" sería
    // contarle a una persona los datos de otra.
    if (matches.length !== 1) return { ...UNKNOWN };

    const match = matches[0];
    // SEC-5 — el opt-out gana sobre todo lo demás; se lee del estado ACTUAL, no de un cache.
    const optedOut = match.whatsappOptOutAt !== null;

    return {
      clientId: match.clientId,
      optedOut,
      identityValues: await this.identityValuesOf(match.clientId, match.name, match.phone),
    };
  }

  /**
   * SEC-1 — strings que NUNCA pueden aparecer en los hechos. Se traen del `Customer` completo
   * (nombre, email, teléfono, domicilio) porque la barrera compara VALORES: sin ellos no
   * podría detectar identidad escondida bajo una clave inocente (`titular: "Juan Pérez"`).
   *
   * Que estos datos estén en memoria es justamente lo que permite garantizar que no salgan.
   * Si el `findById` falla, se degrada a lo que ya se tenía del candidato — menos cobertura,
   * pero jamás romper el motor por armar la lista de comparación.
   */
  private async identityValuesOf(
    clientId: string,
    name: string,
    phone: string | null,
  ): Promise<string[]> {
    const fallback = [name, phone].filter((v): v is string => typeof v === 'string' && v.length > 0);

    try {
      const customer = await this.customers.findById(clientId);
      return [customer.name, customer.email, customer.phone, customer.address].filter(
        (v): v is string => typeof v === 'string' && v.length > 0,
      );
    } catch {
      return fallback;
    }
  }
}
