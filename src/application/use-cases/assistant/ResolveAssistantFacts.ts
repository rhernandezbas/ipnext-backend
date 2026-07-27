import type { AssistantCatalogRepository } from '@domain/ports/AssistantCatalogRepository';
import type {
  AssistantDataSourceRegistry,
  AssistantSubjectContext,
} from '@domain/ports/AssistantDataSourceRegistry';
import { assertFactsArePiiFree } from './assistantPiiGuard';

export interface ResolveAssistantFactsResult {
  /** Hechos ya verificados como libres de PII. Listos para inyectar en el prompt. */
  facts: Record<string, unknown>;
  /** Keys que efectivamente se resolvieron — va a la auditoría (`AssistantRun.dataSources`). */
  resolvedKeys: string[];
}

/**
 * ai-assistant-multiagent (CFG-3 / SEC-1) — arma los HECHOS que se le inyectan al modelo.
 *
 * Resuelve ÚNICAMENTE las `dataSourceKeys` de la intención ganadora. No "todo lo que haya":
 * un tema de estado de cuenta no tiene por qué ver el estado del servicio, y menos datos
 * viajando es menos superficie.
 *
 * Tres filtros en cascada, cada uno con su motivo:
 *  1. **Habilitación en el catálogo** (CFG-3 scenario 2) — una fuente apagada se OMITE y el
 *     resto del contexto se arma igual. Apagar `noc.cortes` no debe romper una intención que
 *     la referenciaba.
 *  2. **Implementación registrada** — una key sin resolver (config vieja, resolver removido)
 *     se omite con warn en vez de reventar.
 *  3. **Aislamiento por resolver** — si uno falla, se omite ESE y el resto sobrevive. Un
 *     hipo de la base consultando facturas no debe dejar al bot sin poder decir nada.
 *
 * Y al final, la barrera dura: `assertFactsArePiiFree` sobre el objeto YA ensamblado. Esa
 * SÍ lanza — un hecho contaminado no se limpia y se manda igual, se corta.
 */
export class ResolveAssistantFacts {
  constructor(
    private readonly catalog: AssistantCatalogRepository,
    private readonly registry: AssistantDataSourceRegistry,
  ) {}

  async execute(
    dataSourceKeys: string[],
    ctx: AssistantSubjectContext,
    forbiddenValues: string[] = [],
  ): Promise<ResolveAssistantFactsResult> {
    if (dataSourceKeys.length === 0) {
      return { facts: {}, resolvedKeys: [] };
    }

    // (1) sólo las habilitadas, preservando el orden pedido (contexto determinístico).
    const enabledKeys = await this.catalog.filterEnabledDataSourceKeys(dataSourceKeys);

    const facts: Record<string, unknown> = {};
    const resolvedKeys: string[] = [];

    for (const key of enabledKeys) {
      // (2) implementación registrada
      const resolver = this.registry.get(key);
      if (!resolver) {
        // eslint-disable-next-line no-console
        console.warn('[assistant] data source configurada sin resolver registrado — omitida', {
          key,
        });
        continue;
      }

      // (3) aislamiento: un resolver caído no tumba a los demás
      try {
        const resolved = await resolver.resolve(ctx);
        facts[key] = resolved;
        resolvedKeys.push(key);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[assistant] resolver de data source falló — omitido, el resto sigue', {
          key,
          error: err instanceof Error ? err.message : err,
        });
      }
    }

    // Barrera dura: si algún resolver filtró identidad, esto LANZA y el motor degrada a
    // no-op. Corre sobre el objeto ensamblado, no por resolver: una fuga puede aparecer
    // recién al combinar.
    assertFactsArePiiFree(facts, forbiddenValues);

    return { facts, resolvedKeys };
  }
}
