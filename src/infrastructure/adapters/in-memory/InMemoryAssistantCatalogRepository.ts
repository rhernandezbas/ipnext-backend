import type { AssistantActionEntry, AssistantDataSourceEntry } from '@domain/entities/assistant';
import {
  ASSISTANT_ACTION_SEED,
  ASSISTANT_DATA_SOURCE_SEED,
  type AssistantCatalogRepository,
} from '@domain/ports/AssistantCatalogRepository';

/**
 * ai-assistant-multiagent (T1.4) — catálogos en memoria, sembrados con el MISMO contenido
 * canónico que la migración (`ASSISTANT_*_SEED`).
 *
 * ⚠️ Este adapter NO implementa alta ni baja de fuentes/acciones, porque el PORT no las
 * declara. Es la frontera de seguridad de R5 hecha código: componer comportamiento con
 * piezas seguras se hace sin deploy (intenciones), pero FABRICAR piezas nuevas requiere
 * registrar un resolver en código y pasar por review.
 */
export class InMemoryAssistantCatalogRepository implements AssistantCatalogRepository {
  private readonly dataSources: Map<string, AssistantDataSourceEntry>;
  private readonly actions: Map<string, AssistantActionEntry>;

  constructor() {
    const now = new Date().toISOString();
    this.dataSources = new Map(
      ASSISTANT_DATA_SOURCE_SEED.map((s) => [s.key, { ...s, updatedAt: now }]),
    );
    this.actions = new Map(ASSISTANT_ACTION_SEED.map((a) => [a.key, { ...a, updatedAt: now }]));
  }

  async listDataSources(): Promise<AssistantDataSourceEntry[]> {
    return [...this.dataSources.values()].map((s) => ({ ...s }));
  }

  async listActions(): Promise<AssistantActionEntry[]> {
    return [...this.actions.values()].map((a) => ({ ...a }));
  }

  /** CFG-3 — devuelve las keys que NO existen. Vacío = todo OK. */
  async findMissingDataSourceKeys(keys: string[]): Promise<string[]> {
    return keys.filter((k) => !this.dataSources.has(k));
  }

  async findMissingActionKeys(keys: string[]): Promise<string[]> {
    return keys.filter((k) => !this.actions.has(k));
  }

  /**
   * CFG-3 scenario 2 — una fuente deshabilitada se OMITE, no rompe: el resto del contexto
   * se arma igual. Apagar `noc.cortes` no debe tumbar una intención que la referenciaba.
   */
  async filterEnabledDataSourceKeys(keys: string[]): Promise<string[]> {
    return keys.filter((k) => this.dataSources.get(k)?.enabled === true);
  }

  async setDataSourceEnabled(
    key: string,
    enabled: boolean,
  ): Promise<AssistantDataSourceEntry | null> {
    const existing = this.dataSources.get(key);
    if (!existing) return null;

    const updated: AssistantDataSourceEntry = {
      ...existing,
      enabled,
      updatedAt: new Date().toISOString(),
    };
    this.dataSources.set(key, updated);
    return { ...updated };
  }
}
