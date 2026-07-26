import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type {
  AssistantDataSourceResolver,
  AssistantSubjectContext,
} from '@domain/ports/AssistantDataSourceRegistry';

/**
 * ai-assistant-multiagent — fuente `cliente.servicio`.
 *
 * Estado del servicio y plan contratado. Proyección EXPLÍCITA: `Contract` incluye
 * `clientName` — un spread acá sería una fuga directa de identidad.
 *
 * Se devuelven TODOS los contratos (la cardinalidad real es 1-2 por cliente) porque un
 * cliente con dos servicios preguntando "¿está activo?" necesita una respuesta que los
 * distinga; colapsar a "el primero" produciría una respuesta segura de estar mal la mitad de
 * las veces.
 */
export class ClienteServicioResolver implements AssistantDataSourceResolver {
  readonly key = 'cliente.servicio';

  constructor(private readonly customers: CustomerRepository) {}

  async resolve(ctx: AssistantSubjectContext): Promise<Record<string, unknown>> {
    if (!ctx.clientId) return { disponible: false, motivo: 'cliente_no_identificado' };

    const [customer, contracts] = await Promise.all([
      this.customers.findById(ctx.clientId),
      this.customers.listContracts(ctx.clientId),
    ]);

    return {
      disponible: true,
      estadoCliente: customer.status,
      contratos: contracts.map((c) => ({
        // Campo por campo. NUNCA `...c` — Contract trae clientName.
        plan: c.plan,
        estado: c.status,
        tecnologia: c.technology,
      })),
    };
  }
}
