import type { AssistantCatalogRepository } from '@domain/ports/AssistantCatalogRepository';
import type { AssistantDataSourceEntry } from '@domain/entities/assistant';
import { UnknownAssistantDataSourceError } from '@domain/errors/assistant';

/**
 * ai-assistant-multiagent (D2 / CFG-3) — prende o apaga una fuente de datos del catálogo.
 *
 * `setDataSourceEnabled` estaba implementado en los dos adapters y **nadie lo llamaba**. El
 * seed de `noc.cortes` dice, literal, "se prende con un tilde cuando el hub salga a
 * producción" — y ese tilde no se había construido. La fuente no se podía habilitar nunca.
 *
 * ⚠️ Esto TOGGLEA una fuente existente; no la crea. Frontera R5 del proposal: las fuentes se
 * registran en CÓDIGO, con review, porque cada una es una puerta a la base. Fabricarlas por
 * formulario sería una inyección con formulario bonito. Por eso una key desconocida se rechaza
 * en vez de crearse.
 *
 * Apagar una fuente NO rompe las intenciones que la referencian: el motor filtra por las
 * habilitadas al resolver los hechos, así que una intención que la usaba simplemente deja de
 * recibir ese dato. Es el comportamiento que hace seguro apagar `noc.cortes` si el hub NOC
 * vuelve a modo oscuro.
 */
export class SetAssistantDataSourceEnabled {
  constructor(private readonly catalog: AssistantCatalogRepository) {}

  async execute(key: string, enabled: boolean): Promise<AssistantDataSourceEntry> {
    const updated = await this.catalog.setDataSourceEnabled(key, enabled);
    // El adapter devuelve `null` cuando la key no existe — se traduce al error de dominio para
    // que la ruta responda 400 nombrando la key, en vez de un 500 opaco.
    if (!updated) throw new UnknownAssistantDataSourceError([key]);

    return updated;
  }
}
