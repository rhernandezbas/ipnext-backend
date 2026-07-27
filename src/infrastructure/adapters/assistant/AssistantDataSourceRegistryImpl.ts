import type {
  AssistantDataSourceRegistry,
  AssistantDataSourceResolver,
} from '@domain/ports/AssistantDataSourceRegistry';

/**
 * ai-assistant-multiagent (design D2) — registro de resolvers, armado en el composition root.
 *
 * Es la frontera R5 hecha objeto: las fuentes disponibles son EXACTAMENTE las que alguien
 * registró acá, en código y con review. La UI puede habilitar o deshabilitar lo que existe;
 * no puede inventar una fuente nueva.
 *
 * ── Sobre `noc.cortes` ──────────────────────────────────────────────────────
 * Está en el CATÁLOGO (deshabilitada) pero NO tiene resolver registrado, y las dos capas
 * dicen lo mismo a propósito: todavía no existe un mapeo confiable
 * `cliente → zona/nodo → alerta NOC`. Registrar un resolver que adivine sería peor que no
 * tenerlo: respondería "no hay cortes en tu zona" con una confianza que no tiene respaldo,
 * que es EXACTAMENTE el modo de falla que este change combate.
 *
 * `ResolveAssistantFacts` maneja el caso sin romperse (omite con warn), así que el sistema es
 * coherente: la fuente figura, está apagada, y aunque alguien la prendiera no resolvería nada
 * hasta que exista el mapeo y su resolver.
 */
export class AssistantDataSourceRegistryImpl implements AssistantDataSourceRegistry {
  private readonly resolvers: Map<string, AssistantDataSourceResolver>;

  constructor(resolvers: AssistantDataSourceResolver[]) {
    this.resolvers = new Map();
    for (const resolver of resolvers) {
      if (this.resolvers.has(resolver.key)) {
        // Dos resolvers para la misma key es un bug de wiring, no una configuración válida:
        // cuál gana dependería del orden del array. Falla fuerte y temprano, al boot.
        throw new Error(`Duplicate assistant data source resolver for key "${resolver.key}"`);
      }
      this.resolvers.set(resolver.key, resolver);
    }
  }

  get(key: string): AssistantDataSourceResolver | null {
    return this.resolvers.get(key) ?? null;
  }

  keys(): string[] {
    return [...this.resolvers.keys()];
  }
}
