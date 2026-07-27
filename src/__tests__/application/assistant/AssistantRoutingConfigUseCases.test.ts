import { GetAssistantRoutingConfig } from '@application/use-cases/assistant/GetAssistantRoutingConfig';
import { UpdateAssistantRoutingConfig } from '@application/use-cases/assistant/UpdateAssistantRoutingConfig';
import { AssistantDefaultAreaWithoutAgentError } from '@domain/errors/assistant';
import { InMemoryAssistantRoutingConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryAssistantRoutingConfigRepository';
import { InMemoryAssistantProfileRepository } from '@infrastructure/adapters/in-memory/InMemoryAssistantProfileRepository';

/**
 * ai-assistant-multiagent (RTR-0) — la perilla del ruteo.
 *
 * Contexto de por qué esto existe: `Conversation.areaId` entra SIEMPRE en NULL (los agentes
 * trabajan dentro de Chatwoot, no en Prominense). Sin un área default el motor resuelve
 * `no_area_no_default` y hace no-op **siempre**. La feature quedó en producción, verde y
 * completamente inerte, porque el modelo existía pero nadie podía escribirlo.
 *
 * Lo que se prueba acá es que la perilla no pueda quedar en una posición que PAREZCA
 * configurada y siga sin atender a nadie.
 */

const makeUseCases = () => {
  const routing = new InMemoryAssistantRoutingConfigRepository();
  const profiles = new InMemoryAssistantProfileRepository();
  return {
    routing,
    profiles,
    get: new GetAssistantRoutingConfig(routing),
    update: new UpdateAssistantRoutingConfig(routing, profiles),
  };
};

describe('GetAssistantRoutingConfig', () => {
  it('sin nada persistido: NADIE atiende lo que entra sin área', async () => {
    const { get } = makeUseCases();

    // El default seguro. Un agente recién instalado no empieza a contestarle a todo el mundo
    // por el solo hecho de existir.
    await expect(get.execute()).resolves.toEqual({
      defaultAreaId: null,
      rerouteEnabled: false,
    });
  });

  it('devuelve lo guardado', async () => {
    const { get, routing } = makeUseCases();
    await routing.update({ defaultAreaId: 'area-soporte', rerouteEnabled: true });

    await expect(get.execute()).resolves.toEqual({
      defaultAreaId: 'area-soporte',
      rerouteEnabled: true,
    });
  });
});

describe('UpdateAssistantRoutingConfig — no se puede apuntar a la nada', () => {
  it('un área CON agente se acepta', async () => {
    const { update, profiles } = makeUseCases();
    await profiles.create({ areaId: 'area-soporte' });

    await expect(
      update.execute({ defaultAreaId: 'area-soporte', rerouteEnabled: false }),
    ).resolves.toMatchObject({ defaultAreaId: 'area-soporte' });
  });

  it('un área SIN agente se RECHAZA — si no, el bot queda mudo pareciendo configurado', async () => {
    // Éste es el test que importa. Guardar un área sin agente no falla en ningún lado:
    // el motor hace `findByAreaId` → null → no-op, en silencio. La pantalla mostraría un
    // ruteo "configurado" y el bot no contestaría nunca. Otra vez el mismo falso verde.
    const { update } = makeUseCases();

    await expect(
      update.execute({ defaultAreaId: 'area-sin-agente', rerouteEnabled: false }),
    ).rejects.toBeInstanceOf(AssistantDefaultAreaWithoutAgentError);
  });

  it('el rechazo NOMBRA el área, para que el operador sepa cuál crear', async () => {
    const { update } = makeUseCases();

    await expect(
      update.execute({ defaultAreaId: 'area-sin-agente', rerouteEnabled: false }),
    ).rejects.toThrow(/area-sin-agente/);
  });

  it('un área inexistente falla igual que una sin agente — el resultado es el mismo', async () => {
    // No se distinguen a propósito: en los dos casos el motor no encuentra perfil y calla.
    // Un mensaje único y accionable es más honesto que dos que terminan en lo mismo.
    const { update } = makeUseCases();

    await expect(
      update.execute({ defaultAreaId: 'no-existe', rerouteEnabled: false }),
    ).rejects.toBeInstanceOf(AssistantDefaultAreaWithoutAgentError);
  });
});

describe('UpdateAssistantRoutingConfig — apagar siempre se puede', () => {
  it('null se acepta sin validar nada: desactivar el ruteo es reversible', async () => {
    const { update, routing } = makeUseCases();
    await routing.update({ defaultAreaId: 'area-vieja', rerouteEnabled: true });

    await expect(
      update.execute({ defaultAreaId: null, rerouteEnabled: false }),
    ).resolves.toEqual({ defaultAreaId: null, rerouteEnabled: false });
  });

  it('volver a null NO exige que el área vieja siga teniendo agente', async () => {
    // Si validáramos al apagar, borrar un agente te dejaría sin forma de apagar el ruteo.
    const { update } = makeUseCases();

    await expect(
      update.execute({ defaultAreaId: null, rerouteEnabled: true }),
    ).resolves.toMatchObject({ defaultAreaId: null });
  });
});

describe('UpdateAssistantRoutingConfig — el re-ruteo', () => {
  it('se persiste junto con el área', async () => {
    const { update, profiles, get } = makeUseCases();
    await profiles.create({ areaId: 'area-soporte' });

    await update.execute({ defaultAreaId: 'area-soporte', rerouteEnabled: true });

    await expect(get.execute()).resolves.toEqual({
      defaultAreaId: 'area-soporte',
      rerouteEnabled: true,
    });
  });

  it('se puede apagar sin tocar el área default', async () => {
    const { update, profiles, get } = makeUseCases();
    await profiles.create({ areaId: 'area-soporte' });
    await update.execute({ defaultAreaId: 'area-soporte', rerouteEnabled: true });

    await update.execute({ defaultAreaId: 'area-soporte', rerouteEnabled: false });

    await expect(get.execute()).resolves.toMatchObject({
      defaultAreaId: 'area-soporte',
      rerouteEnabled: false,
    });
  });
});
