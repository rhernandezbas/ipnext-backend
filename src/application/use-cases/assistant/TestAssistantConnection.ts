import type { AssistantProviderConfigRepository } from '@domain/ports/AssistantProviderConfigRepository';
import { resolveProviderCredentials } from '@domain/ports/AssistantProviderConfigRepository';
import type { AssistantRuntime } from '@domain/ports/AssistantRuntime';
import type { AssistantConnectionTestDto } from '@application/dto/assistantProvider.dto';

export interface AssistantRuntimeFactory {
  (credentials: { baseUrl: string; apiKey: string }): AssistantRuntime;
}

/**
 * ai-assistant-multiagent — "Probar conexión".
 *
 * ⚠️ **La prueba corre EN EL SERVIDOR.** El frontend aprieta un botón y recibe `ok`/`error`;
 * la credencial nunca sale del backend. Si esta llamada la hiciera el navegador, la key
 * tendría que estar en el bundle — que es público.
 *
 * Ejercita el camino REAL (`generate` sobre el adapter productivo), no un `ping` inventado.
 * Es deliberado: el incidente `ORCHESTRATOR_BASE_URL` demostró que una integración "verificada"
 * con curl al upstream puede fallar igual por la capa del gateway. Lo único que se prueba de
 * verdad es lo que se ejecuta de verdad.
 *
 * `AssistantRuntime` no lanza (RUN-1): un fallo vuelve como `unavailable`, así que este use
 * case traduce esa ausencia a un mensaje accionable en vez de tragarla.
 */
export class TestAssistantConnection {
  constructor(
    private readonly providerConfig: AssistantProviderConfigRepository,
    private readonly envCredentials: { baseUrl: string; apiKey: string },
    private readonly runtimeFactory: AssistantRuntimeFactory,
    private readonly model: string,
  ) {}

  async execute(): Promise<AssistantConnectionTestDto> {
    const stored = await this.providerConfig.get();
    const credentials = resolveProviderCredentials(stored, this.envCredentials);

    if (credentials.source === 'none') {
      return {
        ok: false,
        detail:
          'No hay ninguna API key cargada. Guardá una en este formulario o seteá DEEPSEEK_API_KEY en el deploy.',
        latencyMs: null,
      };
    }

    const runtime = this.runtimeFactory(credentials);
    const startedAt = Date.now();

    const result = await runtime.generate({
      model: this.model,
      persona: 'Sos un asistente de prueba de conexión.',
      responseGuide: '',
      thread: [{ role: 'customer', text: 'Respondé únicamente con la palabra: OK' }],
      // `null` = modo CONVERSAR: no se le inyecta NINGÚN dato de clientes a una prueba de
      // conectividad. Probar la conexión no puede ser una excusa para mandar datos reales.
      facts: null,
      timeoutMs: 15_000,
    });

    const latencyMs = Date.now() - startedAt;

    if (result.kind === 'unavailable') {
      return {
        ok: false,
        detail:
          `No se pudo contactar al proveedor usando la credencial de ${credentials.source === 'db' ? 'esta pantalla' : 'el deploy'}. ` +
          'Revisá que la API key sea válida y que el servidor tenga salida a internet.',
        latencyMs,
      };
    }

    return {
      ok: true,
      detail: `Conexión OK usando la credencial de ${credentials.source === 'db' ? 'esta pantalla' : 'el deploy'}.`,
      latencyMs,
    };
  }
}
