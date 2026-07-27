/**
 * ai-assistant-multiagent — credenciales del proveedor de IA, editables en runtime.
 *
 * ⚠️ **`apiKey` es un SECRETO y nunca sale de acá completo.** El DTO de lectura expone
 * `hasApiKey` + `apiKeyLast4` (patrón de enmascarado del repo, molde `NocBroadcastConfigDTO`).
 * Que el formulario viva en el frontend NO significa que la key viva ahí: el front manda la
 * key y recibe una máscara. Todo lo que se descarga al navegador es público.
 */
export interface AssistantProviderConfig {
  /** Vacío ⇒ cae al env var `DEEPSEEK_BASE_URL`. */
  baseUrl: string;
  /** Vacío ⇒ cae al env var `DEEPSEEK_API_KEY`. */
  apiKey: string;
}

export const ASSISTANT_PROVIDER_DEFAULTS: AssistantProviderConfig = {
  baseUrl: '',
  apiKey: '',
};

/**
 * Patch parcial. **`apiKey` vacío o ausente PRESERVA la guardada** — no la borra.
 *
 * Sin esa regla hay un bug garantizado: el GET devuelve la key enmascarada, el operador edita
 * la baseUrl, el formulario manda todo de vuelta… y la máscara se guardaría COMO key. El bot
 * quedaría con `sk-...abc` de credencial y nadie entendería por qué dejó de andar.
 *
 * Para borrar la key de verdad existe `clearApiKey` — un acto explícito, no un efecto colateral.
 */
export interface UpdateAssistantProviderConfigInput {
  baseUrl?: string;
  apiKey?: string;
  /** Borrado EXPLÍCITO: devuelve el control al env var. */
  clearApiKey?: boolean;
}

export interface AssistantProviderConfigRepository {
  get(): Promise<AssistantProviderConfig>;
  update(input: UpdateAssistantProviderConfigInput): Promise<AssistantProviderConfig>;
}

/**
 * Credenciales EFECTIVAS: la DB pisa al env var, el env queda de fallback.
 *
 * Esa precedencia es lo que hace reversible la decisión de guardar la key en la base: si
 * mañana se prefiere volver a `gh secret`, se borra el valor de la DB y todo sigue andando
 * sin tocar una línea de código.
 */
export function resolveProviderCredentials(
  stored: AssistantProviderConfig,
  env: { baseUrl: string; apiKey: string },
): { baseUrl: string; apiKey: string; source: 'db' | 'env' | 'none' } {
  const baseUrl = stored.baseUrl || env.baseUrl;
  const apiKey = stored.apiKey || env.apiKey;

  return {
    baseUrl,
    apiKey,
    source: apiKey === '' ? 'none' : stored.apiKey !== '' ? 'db' : 'env',
  };
}
