import {
  ASSISTANT_PROVIDER_DEFAULTS,
  type AssistantProviderConfig,
  type AssistantProviderConfigRepository,
  type UpdateAssistantProviderConfigInput,
} from '@domain/ports/AssistantProviderConfigRepository';
import { prisma } from '../../database/prisma';

const SINGLETON_ID = 'singleton';

/**
 * ai-assistant-multiagent — credenciales del proveedor en Prisma.
 *
 * `update` implementa la regla que evita el bug clásico del formulario: **un `apiKey` vacío o
 * ausente PRESERVA la guardada**. Sólo `clearApiKey` la borra, y es un acto explícito.
 */
export class PrismaAssistantProviderConfigRepository implements AssistantProviderConfigRepository {
  async get(): Promise<AssistantProviderConfig> {
    const row = await prisma.assistantProviderConfig.findUnique({ where: { id: SINGLETON_ID } });
    if (!row) return { ...ASSISTANT_PROVIDER_DEFAULTS };

    return { baseUrl: row.baseUrl, apiKey: row.apiKey };
  }

  async update(input: UpdateAssistantProviderConfigInput): Promise<AssistantProviderConfig> {
    const current = await this.get();

    const apiKey = input.clearApiKey ? '' : input.apiKey ? input.apiKey : current.apiKey;
    const baseUrl = input.baseUrl ?? current.baseUrl;

    const row = await prisma.assistantProviderConfig.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, baseUrl, apiKey },
      update: { baseUrl, apiKey },
    });

    return { baseUrl: row.baseUrl, apiKey: row.apiKey };
  }
}
