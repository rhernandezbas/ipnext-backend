import type { AssistantIntent, AssistantOutcome, AssistantProfile } from '@domain/entities/assistant';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import type { AssistantRoutingConfigRepository } from '@domain/ports/AssistantRoutingConfigRepository';
import type {
  AssistantIntentRepository,
  AssistantProfileRepository,
} from '@domain/ports/AssistantProfileRepository';
import type { AssistantThreadReader } from '@domain/ports/AssistantThreadReader';
import type { AssistantClientResolver } from '@domain/ports/AssistantClientResolver';
import type {
  AssistantClassifyCandidate,
  AssistantRuntime,
  AssistantThreadTurn,
} from '@domain/ports/AssistantRuntime';
import {
  ASSISTANT_LABEL_NEEDS_HUMAN,
  ASSISTANT_LABEL_REPLIED,
  type AssistantConversationGateway,
} from '@domain/ports/AssistantConversationGateway';
import type { AssistantRunRepository } from '@domain/ports/AssistantRunRepository';
import type { ResolveAssistantFacts } from './ResolveAssistantFacts';
import { evaluateActionPermission, evaluateEntryPreconditions, evaluateProfilePreconditions } from './assistantGuards';
import { resolveAssistantRouting, shouldAttemptReroute } from './assistantRouting';
import { redactPii } from './assistantPiiGuard';
import { buildNumberWhitelist, findUnbackedNumbers } from './assistantNumberVerifier';

/** RUN-4 — kill-switch global, leído POR INVOCACIÓN (no cacheado al boot). */
export const ASSISTANT_ENABLED_FLAG = 'ai-assistant-enabled';

/** Turnos de hilo que se le mandan al modelo. Acota costo y respeta la ventana de contexto. */
const THREAD_TURN_LIMIT = 20;

/**
 * ANTI-RÁFAGA — ventana en la que NO se vuelve a responder la misma conversación.
 *
 * 12 s cubre la ráfaga típica de WhatsApp (mensajes partidos en 2-5 s) sin sentirse mudo:
 * un cliente que escribe de nuevo pasados 12 s ya espera respuesta. El mensaje salteado no se
 * pierde — el próximo turno lee el HILO completo (CONV-1) y lo tiene en cuenta.
 */
const REPLY_DEBOUNCE_MS = 12_000;

export interface ReplyWithAssistantCommand {
  conversationId: string;
  areaId: string | null;
  direction: 'inbound' | 'outbound' | null;
  isPrivate: boolean;
  /** SEC-3 — ventana de 24 h, del mirror. Nunca se recalcula acá. */
  canReply: boolean;
  contactPhone: string | null;
}

interface RunRecord {
  outcome: AssistantOutcome;
  reason: string | null;
  profileId?: string | null;
  areaId?: string | null;
  intentName?: string | null;
  dataSources?: string[];
  actionKey?: string | null;
}

/**
 * ai-assistant-multiagent — EL MOTOR. Pipeline conversacional de 7 etapas (design D1).
 *
 * ```
 * 1. CARGAR      hilo completo, con PII redactada en TODOS los turnos (CONV-1/CONV-5)
 * 2. CLASIFICAR  el modelo lee el hilo → intent | chat | out_of_scope
 * 3. DECIDIR     CÓDIGO: ¿acción habilitada? ¿ventana? ¿opt-out?     → si no: handoff
 * 4. RESOLVER    CÓDIGO: los dataSources del tema (en CONVERSAR: ninguno)
 * 5. REDACTAR    el modelo escribe con el hilo + los hechos
 * 6. VERIFICAR   CÓDIGO: SEC-4 números                                → si falla: handoff
 * 7. EJECUTAR    vía los use cases de siempre + rastro en Chatwoot
 * ```
 *
 * Las etapas 1, 3, 4 y 6 son código determinístico: ahí vive toda la seguridad. El modelo
 * participa de 2 y 5, y en ambas su salida se valida antes de usarse.
 *
 * **RUN-1 — este use case NUNCA lanza.** Cualquier excepción se atrapa, se registra como
 * `outcome:'error'` y se devuelve. El webhook que lo invoca debe poder ackear 200 siempre.
 */
export class ReplyWithAssistant {
  constructor(
    private readonly flags: FeatureFlagRepository,
    private readonly routingConfig: AssistantRoutingConfigRepository,
    private readonly profiles: AssistantProfileRepository,
    private readonly intents: AssistantIntentRepository,
    private readonly threadReader: AssistantThreadReader,
    private readonly clients: AssistantClientResolver,
    private readonly facts: ResolveAssistantFacts,
    private readonly runtime: AssistantRuntime,
    private readonly gateway: AssistantConversationGateway,
    private readonly runs: AssistantRunRepository,
  ) {}

  async execute(command: ReplyWithAssistantCommand): Promise<AssistantOutcome> {
    const startedAt = Date.now();
    try {
      const record = await this.run(command);
      await this.recordRun(command, record, Date.now() - startedAt);
      return record.outcome;
    } catch (err) {
      // RUN-1 — nada sale de acá. Incluye `AssistantPiiLeakError`: una fuga detectada corta
      // la respuesta y queda auditada, pero JAMÁS tumba el webhook.
      // eslint-disable-next-line no-console
      console.error('[assistant] el motor falló — degradado a no-op', {
        conversationId: command.conversationId,
        error: err instanceof Error ? err.message : err,
      });

      // ── Fix de review adversarial ──────────────────────────────────────────
      // Antes, un fallo por excepción registraba el error y NADA MÁS: sin label, sin nota.
      // El cliente preguntaba, el bot se rompía por dentro y ningún humano se enteraba — la
      // conversación quedaba huérfana con apariencia de atendida. Es exactamente el modo de
      // falla que este change combate, colado por el camino de excepción.
      // El rastro es best-effort (`safely`): si Chatwoot también está caído, no se reintenta.
      await this.safely(() =>
        this.gateway.applyLabels(command.conversationId, [ASSISTANT_LABEL_NEEDS_HUMAN]),
      );
      await this.safely(() =>
        this.gateway.privateNote(
          command.conversationId,
          '🤖 Tuve un problema técnico y no pude responder esta consulta. Queda para vos.',
        ),
      );

      await this.recordRun(
        command,
        { outcome: 'error', reason: 'engine_error' },
        Date.now() - startedAt,
      ).catch(() => undefined);
      return 'error';
    }
  }

  private async run(command: ReplyWithAssistantCommand): Promise<RunRecord> {
    // ── Etapa 0a — guardas baratas, sin tocar la base ────────────────────────
    // Flag ausente ⇒ tratado como APAGADO. Fail-closed: si la fila del seed no está (base sin
    // migrar, borrado accidental), el bot calla en vez de asumir que puede hablar.
    const flag = await this.flags.get(ASSISTANT_ENABLED_FLAG);
    const flagEnabled = flag?.enabled === true;
    const entry = evaluateEntryPreconditions({
      flagEnabled,
      direction: command.direction,
      isPrivate: command.isPrivate,
    });
    if (!entry.proceed) return { outcome: 'noop', reason: entry.reason };

    // ── Etapa 0b — ruteo (RTR-0): sin área, atiende el agente default ────────
    const routing = await this.routingConfig.get();
    const route = resolveAssistantRouting(command.areaId, routing);
    if (route.kind === 'none') return { outcome: 'noop', reason: route.reason };

    const profile = await this.profiles.findByAreaId(route.areaId);
    const client = await this.clients.resolveByPhone(command.contactPhone);

    const profileCheck = evaluateProfilePreconditions({ profile, optedOut: client.optedOut });
    if (!profileCheck.proceed) {
      return { outcome: 'noop', reason: profileCheck.reason, areaId: route.areaId };
    }
    // `evaluateProfilePreconditions` ya garantizó que no es null.
    const activeProfile = profile as AssistantProfile;

    // ── ANTI-RÁFAGA (review adversarial) ─────────────────────────────────────
    // El cliente manda "hola" / "quería consultar" / "sobre mi factura" en cinco segundos:
    // tres webhooks, tres corridas del motor, tres respuestas pisándose. Si el asistente YA
    // respondió hace instantes, este turno se salta — el mensaje sigue en el hilo y el
    // próximo turno lo va a leer igual (el insumo es el HILO completo, CONV-1), así que no
    // se pierde nada: se evita hablarle encima a alguien que todavía está escribiendo.
    const since = new Date(Date.now() - REPLY_DEBOUNCE_MS).toISOString();
    if (await this.runs.hasRepliedSince(command.conversationId, since)) {
      return {
        outcome: 'noop',
        reason: 'debounced_recent_reply',
        profileId: activeProfile.id,
        areaId: route.areaId,
      };
    }

    // ── Etapa 1 — el HILO, con PII redactada en TODOS los turnos ─────────────
    const rawThread = await this.threadReader.readRecentTurns(
      command.conversationId,
      THREAD_TURN_LIMIT,
    );
    const thread: AssistantThreadTurn[] = rawThread.map((t) => ({
      role: t.role,
      text: redactPii(t.text),
    }));

    // ── Etapa 2 — clasificar contra las intents del perfil (RTR-2) ───────────
    const enabledIntents = await this.intents.listEnabledByProfileId(activeProfile.id);
    const classification = await this.runtime.classify({
      model: activeProfile.classifierModel ?? activeProfile.model,
      persona: activeProfile.persona,
      thread,
      candidates: toCandidates(enabledIntents),
      timeoutMs: activeProfile.timeoutMs,
    });

    if (classification.kind === 'unavailable') {
      // El modelo no respondió. NO es "fuera de alcance": no sabemos qué pedía el cliente,
      // así que no se le dice nada y queda para el humano.
      await this.markNeedsHuman(command.conversationId, activeProfile, 'no pude clasificar la consulta');
      return {
        outcome: 'error',
        reason: 'classifier_unavailable',
        profileId: activeProfile.id,
        areaId: route.areaId,
      };
    }

    let workingProfile = activeProfile;
    let workingAreaId = route.areaId;
    let intent: AssistantIntent | null = null;

    if (classification.kind === 'intent') {
      intent = enabledIntents.find((i) => i.id === classification.key) ?? null;
    }

    // ── Etapa 2b — re-ruteo (RTR-0) ─────────────────────────────────────────
    if (
      shouldAttemptReroute({
        rerouteEnabled: routing.rerouteEnabled,
        viaDefault: route.viaDefault,
        classifiedOutOfScope: classification.kind === 'out_of_scope',
      })
    ) {
      const rerouted = await this.tryReroute(activeProfile.id, thread, activeProfile);
      if (rerouted) {
        workingProfile = rerouted.profile;
        workingAreaId = rerouted.profile.areaId;
        intent = rerouted.intent;
        // La reasignación pasa por el use case de siempre ⇒ queda `area_changed` en el feed.
        await this.gateway.setArea(command.conversationId, workingAreaId);
      }
    }

    // Fuera de alcance y sin re-ruteo posible ⇒ handoff explícito, con rastro en Chatwoot.
    if (classification.kind === 'out_of_scope' && !intent) {
      await this.markNeedsHuman(command.conversationId, workingProfile, 'consulta fuera de alcance');
      return {
        outcome: 'handoff',
        reason: 'out_of_scope',
        profileId: workingProfile.id,
        areaId: workingAreaId,
      };
    }
    if (classification.kind === 'intent' && !intent) {
      // El modelo devolvió una key que no existe entre las candidatas. Default deny.
      await this.markNeedsHuman(command.conversationId, workingProfile, 'no pude resolver el tema');
      return {
        outcome: 'handoff',
        reason: 'unknown_intent_key',
        profileId: workingProfile.id,
        areaId: workingAreaId,
      };
    }

    // ── Etapa 3 — ¿se puede ejecutar la acción? (ACT-1 + SEC-3) ──────────────
    // En modo CONVERSAR la acción es siempre responder: charlar es hablarle al cliente.
    const actionKey = intent?.actionKey ?? 'whatsapp_reply';
    const permission = evaluateActionPermission({
      actionKey,
      enabledActions: workingProfile.enabledActions,
      canReply: command.canReply,
    });
    if (!permission.allowed) {
      await this.markNeedsHuman(
        command.conversationId,
        workingProfile,
        permission.reason === 'outside_reply_window'
          ? 'llegó una consulta fuera de la ventana de 24 h'
          : 'la acción necesaria no está habilitada',
      );
      return {
        outcome: 'handoff',
        reason: permission.reason,
        profileId: workingProfile.id,
        areaId: workingAreaId,
        intentName: intent?.name ?? null,
        actionKey,
      };
    }

    // ── Etapa 4 — hechos. En CONVERSAR: NINGUNO (CONV-2) ────────────────────
    const resolved = intent
      ? await this.facts.execute(
          intent.dataSourceKeys,
          { clientId: client.clientId, conversationId: command.conversationId, areaId: workingAreaId },
          client.identityValues,
        )
      : { facts: {}, resolvedKeys: [] };

    // ── Etapa 5 — redactar ──────────────────────────────────────────────────
    const generated = await this.runtime.generate({
      model: workingProfile.model,
      persona: workingProfile.persona,
      responseGuide: intent?.responseGuide ?? '',
      thread,
      // `null` marca modo CONVERSAR: sin hechos, el whitelist de SEC-4 queda vacío.
      facts: intent ? resolved.facts : null,
      timeoutMs: workingProfile.timeoutMs,
    });

    const base = {
      profileId: workingProfile.id,
      areaId: workingAreaId,
      intentName: intent?.name ?? null,
      dataSources: resolved.resolvedKeys,
      actionKey,
    };

    if (generated.kind === 'unavailable') {
      await this.markNeedsHuman(command.conversationId, workingProfile, 'no pude redactar la respuesta');
      return { ...base, outcome: 'error', reason: 'generator_unavailable' };
    }
    if (generated.kind === 'cannot_answer') {
      // El propio modelo pidió handoff (centinela NO_PUEDO_RESPONDER, D8).
      await this.markNeedsHuman(command.conversationId, workingProfile, 'el asistente no supo responder');
      return { ...base, outcome: 'handoff', reason: 'model_cannot_answer' };
    }

    // ── Etapa 6 — SEC-4: ¿inventó algún número? ──────────────────────────────
    const whitelist = buildNumberWhitelist({
      facts: intent ? resolved.facts : {},
      profileTexts: [workingProfile.persona, workingProfile.handoffMessage, intent?.responseGuide ?? ''],
      // SÓLO lo que escribió el cliente. Los turnos del bot NO: si no, una cifra alucinada
      // en un turno anterior se lavaría y pasaría a ser "verdad histórica".
      customerMessages: thread.filter((t) => t.role === 'customer').map((t) => t.text),
    });
    const unbacked = findUnbackedNumbers(generated.text, whitelist);
    if (unbacked.length > 0) {
      await this.markNeedsHuman(
        command.conversationId,
        workingProfile,
        'descarté una respuesta que contenía cifras sin respaldo',
      );
      return { ...base, outcome: 'rejected_numbers', reason: 'number_not_in_facts' };
    }

    // ── Etapa 7 — ejecutar + rastro en Chatwoot (D11) ───────────────────────
    await this.executeAction(command.conversationId, actionKey, generated.text, workingAreaId);
    // Best-effort: si el label falla, la respuesta YA salió y el motor no debe romperse.
    await this.safely(() =>
      this.gateway.applyLabels(command.conversationId, [ASSISTANT_LABEL_REPLIED]),
    );

    return { ...base, outcome: 'replied', reason: null };
  }

  /**
   * RTR-0 — busca un tema entre las OTRAS áreas con agente habilitado. Sólo corre cuando el
   * agente default no supo qué hacer y la conversación no fue clasificada por un humano.
   */
  private async tryReroute(
    currentProfileId: string,
    thread: AssistantThreadTurn[],
    defaultProfile: AssistantProfile,
  ): Promise<{ profile: AssistantProfile; intent: AssistantIntent } | null> {
    const allProfiles = await this.profiles.list();
    const others = allProfiles.filter((p) => p.enabled && p.id !== currentProfileId);
    if (others.length === 0) return null;

    const byKey = new Map<string, { profile: AssistantProfile; intent: AssistantIntent }>();
    const candidates: AssistantClassifyCandidate[] = [];
    for (const profile of others) {
      for (const intent of await this.intents.listEnabledByProfileId(profile.id)) {
        byKey.set(intent.id, { profile, intent });
        candidates.push({
          key: intent.id,
          name: intent.name,
          description: intent.description,
          examples: intent.examples,
        });
      }
    }
    if (candidates.length === 0) return null;

    const result = await this.runtime.classify({
      model: defaultProfile.classifierModel ?? defaultProfile.model,
      persona: defaultProfile.persona,
      thread,
      candidates,
      timeoutMs: defaultProfile.timeoutMs,
    });

    return result.kind === 'intent' ? (byKey.get(result.key) ?? null) : null;
  }

  private async executeAction(
    conversationId: string,
    actionKey: string,
    text: string,
    areaId: string,
  ): Promise<void> {
    switch (actionKey) {
      case 'whatsapp_reply':
        return this.gateway.reply(conversationId, text);
      case 'private_note':
        return this.gateway.privateNote(conversationId, text);
      case 'apply_label':
        return this.gateway.applyLabels(conversationId, [ASSISTANT_LABEL_REPLIED]);
      case 'suggest_area':
        return this.gateway.setArea(conversationId, areaId);
      case 'resolve_conversation':
        return this.gateway.resolve(conversationId);
      default:
        // Una acción del catálogo sin implementación acá: default deny, no adivinar.
        // eslint-disable-next-line no-console
        console.warn('[assistant] acción sin implementación — no se ejecuta', { actionKey });
    }
  }

  /**
   * D11 — el rastro del handoff tiene que ser VISIBLE EN CHATWOOT. Los agentes trabajan ahí,
   * no en el inbox de Prominense: un handoff que sólo quedara en nuestra base sería silencio,
   * no aviso — el cliente preguntó, el bot calló, y nadie se entera.
   */
  private async markNeedsHuman(
    conversationId: string,
    profile: AssistantProfile,
    reason: string,
  ): Promise<void> {
    await this.safely(() =>
      this.gateway.applyLabels(conversationId, [ASSISTANT_LABEL_NEEDS_HUMAN]),
    );
    await this.safely(() =>
      this.gateway.privateNote(conversationId, `🤖 ${reason}. ${profile.handoffMessage}`.trim()),
    );
  }

  /** El rastro es best-effort: nunca puede tumbar al motor (RUN-1). */
  private async safely(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[assistant] rastro en Chatwoot falló (best-effort)', {
        error: err instanceof Error ? err.message : err,
      });
    }
  }

  private async recordRun(
    command: ReplyWithAssistantCommand,
    record: RunRecord,
    latencyMs: number,
  ): Promise<void> {
    await this.safely(async () => {
      await this.runs.record({
        profileId: record.profileId ?? null,
        areaId: record.areaId ?? command.areaId,
        subjectType: 'conversation',
        subjectId: command.conversationId,
        intentName: record.intentName ?? null,
        dataSources: record.dataSources ?? [],
        actionKey: record.actionKey ?? null,
        outcome: record.outcome,
        reason: record.reason,
        latencyMs,
      });
    });
  }
}

/** RTR-2 — las candidatas llevan el id de la intención como handle opaco. */
function toCandidates(intents: AssistantIntent[]): AssistantClassifyCandidate[] {
  return intents.map((i) => ({
    key: i.id,
    name: i.name,
    description: i.description,
    examples: i.examples,
  }));
}
