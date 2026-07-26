import {
  ASSISTANT_ROUTING_DEFAULTS,
  type AssistantRoutingConfig,
  type AssistantRoutingConfigRepository,
} from '@domain/ports/AssistantRoutingConfigRepository';
import { prisma } from '../../database/prisma';

/** La fila única siempre lleva este id (`@default("singleton")` en el schema). */
const SINGLETON_ID = 'singleton';

/**
 * ai-assistant-multiagent (RTR-0) — ruteo en Prisma. La migración siembra la fila con
 * `defaultAreaId: NULL`, así que `get()` normalmente encuentra fila; los defaults del port
 * cubren el caso de una base a la que le falte el seed.
 */
export class PrismaAssistantRoutingConfigRepository implements AssistantRoutingConfigRepository {
  async get(): Promise<AssistantRoutingConfig> {
    const row = await prisma.assistantRoutingConfig.findUnique({ where: { id: SINGLETON_ID } });
    if (!row) return { ...ASSISTANT_ROUTING_DEFAULTS };

    return {
      defaultAreaId: row.defaultAreaId,
      rerouteEnabled: row.rerouteEnabled,
    };
  }

  async update(config: AssistantRoutingConfig): Promise<AssistantRoutingConfig> {
    const row = await prisma.assistantRoutingConfig.upsert({
      where: { id: SINGLETON_ID },
      create: {
        id: SINGLETON_ID,
        defaultAreaId: config.defaultAreaId,
        rerouteEnabled: config.rerouteEnabled,
      },
      update: {
        defaultAreaId: config.defaultAreaId,
        rerouteEnabled: config.rerouteEnabled,
      },
    });

    return { defaultAreaId: row.defaultAreaId, rerouteEnabled: row.rerouteEnabled };
  }
}
