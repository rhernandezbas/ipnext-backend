import type { AssistantProviderConfig } from '@domain/ports/AssistantProviderConfigRepository';

/**
 * ai-assistant-multiagent — DTO de lectura de las credenciales del proveedor.
 *
 * ⚠️ **La `apiKey` NUNCA se serializa.** Se expone `hasApiKey` (¿hay una cargada?) y
 * `apiKeyLast4` (los últimos 4 caracteres, para que el operador reconozca CUÁL cargó sin que
 * la key viaje). Mismo patrón que `NocBroadcastConfigDTO`.
 *
 * Si algún día alguien agrega `apiKey` a este shape "para debuggear", la está publicando en
 * el navegador de todos los que abran la pantalla.
 */
export interface AssistantProviderConfigDto {
  baseUrl: string;
  /** True cuando hay una key EFECTIVA (de la DB o del env). */
  hasApiKey: boolean;
  /** Últimos 4 caracteres de la key guardada en la DB, o `null`. */
  apiKeyLast4: string | null;
  /**
   * De dónde sale la credencial que se está usando:
   * - `db`   — cargada desde esta pantalla (pisa al env)
   * - `env`  — del secret del deploy (`DEEPSEEK_API_KEY`)
   * - `none` — no hay ninguna: el asistente está mudo
   */
  source: 'db' | 'env' | 'none';
}

export function toAssistantProviderConfigDto(
  stored: AssistantProviderConfig,
  effective: { baseUrl: string; apiKey: string; source: 'db' | 'env' | 'none' },
): AssistantProviderConfigDto {
  return {
    baseUrl: effective.baseUrl,
    hasApiKey: effective.apiKey !== '',
    // Sólo de la key GUARDADA: mostrar los últimos 4 de una key que vive en un secret del
    // deploy filtraría parte de un valor que esta pantalla no administra.
    apiKeyLast4: stored.apiKey.length >= 4 ? stored.apiKey.slice(-4) : null,
    source: effective.source,
  };
}

/** Resultado de "Probar conexión" — la prueba corre EN EL SERVIDOR, nunca en el navegador. */
export interface AssistantConnectionTestDto {
  ok: boolean;
  /** Mensaje para el operador. En caso de fallo NUNCA incluye la key ni headers crudos. */
  detail: string;
  latencyMs: number | null;
}
