import type { AssistantActionEntry, AssistantDataSourceEntry } from '@domain/entities/assistant';

/**
 * ai-assistant-multiagent (CFG-3) — catálogos de FUENTES DE DATOS y ACCIONES.
 *
 * ⚠️ FRONTERA DE SEGURIDAD (proposal R5). Este port expone LEER y HABILITAR/DESHABILITAR.
 * NO expone `create` ni `delete` — y eso es deliberado, no una omisión:
 *
 *   Cada fuente y cada acción es UNA PUERTA A LA BASE DE DATOS. Su implementación se
 *   registra en código (`AssistantDataSourceRegistry`). Permitir definirlas desde la UI
 *   sería una inyección SQL con formulario bonito: un operador distraído —o alguien con
 *   malas intenciones— podría fabricar una fuente que lea cualquier tabla.
 *
 * Componer comportamiento con piezas seguras: sí, y sin deploy (eso son las intenciones,
 * CFG-2). Fabricar piezas nuevas: sólo en código, con review.
 *
 * Las filas las siembra la migración de forma idempotente (`ON CONFLICT (key) DO NOTHING`),
 * porque el deploy corre `migrate deploy` pero NUNCA `prisma db seed`.
 */
/**
 * Contenido canónico del catálogo de FUENTES.
 *
 * ⚠️ ESPEJO de la migración `20261023000000_ai_assistant_multiagent` (el SQL no puede
 * importar TypeScript, así que la duplicación es inevitable). Si agregás una fuente acá,
 * agregala TAMBIÉN en la migración con `ON CONFLICT (key) DO NOTHING` — si no, el
 * in-memory y prod divergen y la suite queda verde mintiendo.
 *
 * `noc.cortes` arranca DESHABILITADA a propósito (design D2): con el hub NOC en modo
 * oscuro, responder "no hay cortes en tu zona" sería afirmar sin saber.
 */
export const ASSISTANT_DATA_SOURCE_SEED: ReadonlyArray<{
  key: string;
  label: string;
  enabled: boolean;
}> = [
  { key: 'cliente.saldo', label: 'Saldo y vencimiento', enabled: true },
  { key: 'cliente.servicio', label: 'Estado del servicio y plan', enabled: true },
  { key: 'os.abiertas', label: 'Órdenes de servicio abiertas', enabled: true },
  { key: 'noc.cortes', label: 'Cortes activos en la zona', enabled: false },
];

/**
 * Contenido canónico del catálogo de ACCIONES. Mismo espejo con la migración.
 *
 * TODAS operan sobre la CONVERSACIÓN de Chatwoot: los agentes humanos trabajan dentro de
 * Chatwoot, no en el inbox de Prominense (aclaración del usuario, 2026-07-26). Por eso una
 * marca que sólo viva en nuestra base NO cumple OBS-2 — el humano no la ve. Todo lo que el
 * bot hace tiene que ser visible EN Chatwoot: nota privada, label o cambio de estado.
 *
 * `private_note` es la acción más valiosa del set y el primer paso del encendido: el bot
 * deja su sugerencia en el hilo, el agente la lee sin cambiar de herramienta y decide él.
 * Riesgo hacia el cliente: cero. Y ejercita el motor COMPLETO con tráfico real.
 */
export const ASSISTANT_ACTION_SEED: ReadonlyArray<{
  key: string;
  label: string;
  riskLevel: 'green' | 'yellow' | 'red';
}> = [
  { key: 'private_note', label: 'Dejar nota privada en Chatwoot', riskLevel: 'green' },
  { key: 'apply_label', label: 'Etiquetar la conversación', riskLevel: 'green' },
  { key: 'suggest_area', label: 'Reclasificar el área', riskLevel: 'green' },
  { key: 'whatsapp_reply', label: 'Responder al cliente por WhatsApp', riskLevel: 'yellow' },
  // 🔴 Marcar resuelta una conversación cuyo pedido seguía vivo entierra el reclamo y el
  // cliente queda sin respuesta. Requiere eval registrado (EVAL-2).
  { key: 'resolve_conversation', label: 'Marcar la conversación como resuelta', riskLevel: 'red' },
];

export interface AssistantCatalogRepository {
  listDataSources(): Promise<AssistantDataSourceEntry[]>;
  listActions(): Promise<AssistantActionEntry[]>;

  /**
   * CFG-3 — valida que TODAS las keys existan en el catálogo de fuentes. Devuelve las que
   * NO existen (vacío = todo OK). El caller responde 400 con esa lista: una key inventada
   * se rechaza en configuración, NUNCA llega a ejecutarse.
   */
  findMissingDataSourceKeys(keys: string[]): Promise<string[]>;

  /** Ídem para acciones. Una `actionKey` inexistente es un 400 en configuración. */
  findMissingActionKeys(keys: string[]): Promise<string[]>;

  /**
   * Fuentes HABILITADAS de entre las pedidas. El motor resuelve sólo estas: una fuente
   * deshabilitada en el catálogo se omite con warn y el resto del contexto se arma igual
   * (CFG-3, scenario 2) — apagar `noc.cortes` NO debe romper una intención que la usaba.
   */
  filterEnabledDataSourceKeys(keys: string[]): Promise<string[]>;

  /** Toggle de habilitación. `null` si la key no existe. */
  setDataSourceEnabled(key: string, enabled: boolean): Promise<AssistantDataSourceEntry | null>;
}
