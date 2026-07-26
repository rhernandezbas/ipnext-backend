import type { AssistantCatalogRepository } from '@domain/ports/AssistantCatalogRepository';
import {
  toAssistantActionDto,
  toAssistantDataSourceDto,
  type AssistantCatalogsDto,
} from '@application/dto/assistant.dto';

/**
 * ai-assistant-multiagent (CFG-3) — catálogos de fuentes y acciones para el editor del FE.
 *
 * Es lo que llena los checkboxes de la pantalla de configuración: el operador COMPONE
 * comportamiento eligiendo de acá, pero no puede fabricar piezas nuevas (frontera R5).
 * `riskLevel` viaja al FE para que pinte el chip de riesgo y exija doble confirmación en las
 * acciones `red`.
 */
export class ListAssistantCatalogs {
  constructor(private readonly catalog: AssistantCatalogRepository) {}

  async execute(): Promise<AssistantCatalogsDto> {
    const [dataSources, actions] = await Promise.all([
      this.catalog.listDataSources(),
      this.catalog.listActions(),
    ]);

    return {
      dataSources: dataSources.map(toAssistantDataSourceDto),
      actions: actions.map(toAssistantActionDto),
    };
  }
}
