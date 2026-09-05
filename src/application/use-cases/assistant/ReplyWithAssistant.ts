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
import {
  evaluateActionPermission,
  evaluateAgentActivity,
  evaluateEntryPreconditions,
  evaluateProfilePreconditions,
} from './assistantGuards';
import { matchTriggerIntent } from './assistantTriggers';
import { detectPaymentPromise, extractComprobanteOperacion } from './comprobantes';
import { selectComprobanteOutcome } from './selectComprobanteOutcome';
import { renderBalanceSignMessage } from './renderBalanceSignMessage';
import { renderTransferAcknowledgement } from './renderTransferAcknowledgement';
import { contradictsBalanceState } from './assistantPhraseGuard';
import { renderInvoiceBlock } from './renderInvoiceBlock';
import { splitForWhatsapp } from './splitForWhatsapp';
import type { AssistantInvoiceFact } from '@domain/ports/AssistantInvoicesReader';
import type { AssistantThreadMessage } from '@domain/ports/AssistantThreadReader';
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
  /**
   * ai-assistant-cobranzas (D4.2 / SEC-6) — quién tiene la conversación asignada EN CHATWOOT,
   * leído de `conversation.meta.assignee` del payload que dispara esta corrida.
   *
   * Sale del payload y no de una columna espejo a propósito: el payload es la verdad del
   * instante (cero latencia, cero staleness), y hoy no se procesan los eventos
   * `assignee_changed`/`conversation_updated`, así que una columna espejo sólo se escribiría
   * desde `message_created` — la MISMA información, más una migración y una columna que puede
   * quedar vieja APARENTANDO que protege.
   *
   * ⚠️ fix wave W2 — los dos "vacíos" NO son lo mismo:
   *  - `null`      = Chatwoot dijo que NO hay asignado ⇒ el motor puede hablar;
   *  - `undefined` = el payload no trae el campo (drift de versión, otro evento, caller viejo)
   *    ⇒ **no sabemos**, y el motor lo trata como ASIGNADO (fail-closed) dejando un warning.
   */
  assigneeName?: string | null;
}

/** ai-assistant-cobranzas (fix wave W1) — perillas del motor que NO son de negocio. */
export interface ReplyWithAssistantOptions {
  /** SEC-6 — minutos hacia atrás en los que un turno de agente humano frena al bot. */
  agentActiveWindowMinutes?: number;
  /** Reloj inyectable (tests). */
  now?: () => Date;
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
    /**
     * ai-assistant-cobranzas (fix wave W1 / SEC-6) — ventana de "hay un humano atendiendo" y
     * reloj inyectable. Opcional: sin opciones, 60 min y `new Date()` (el default de
     * `evaluateAgentActivity`), y ningún call site viejo se rompe.
     */
    private readonly options: ReplyWithAssistantOptions = {},
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
      // `AssistantThreadMessage.generatedByAssistant` MUST NOT llegar al prompt (D4/2.2): el
      // modelo sigue viendo sólo `customer`/`assistant`, sin distinguir bot de agente humano.
      role: t.role === 'customer' ? 'customer' : 'assistant',
      text: redactPii(t.text),
    }));

    // ── Etapa 1b — SEC-6: ¿hay un humano atendiendo? ────────────────────────
    // Va ANTES del clasificador a propósito: descubrir que hay que callarse no puede costar
    // una llamada al modelo. Dos señales independientes, las dos determinísticas:
    //   1. el HILO ya tiene una respuesta de un agente humano después del último mensaje del
    //      cliente (`evaluateAgentActivity`);
    //   2. el payload de Chatwoot que disparó esta corrida trae `assignee` (D4.2).
    // Cualquiera de las dos alcanza. Hablarle encima a un agente en el medio de una
    // conversación es peor que quedarse callado: el silencio se recupera, la interrupción no.
    // W2 (fix wave) — el campo AUSENTE no es "sin asignar": es "no sabemos". Un drift de
    // versión de Chatwoot, o un evento con otra forma de payload, apagaba en SILENCIO la
    // señal (b) de SEC-6 y el bot se ponía a hablar sobre conversaciones que podían estar en
    // manos de un agente. `null` explícito SÍ es "sin asignar" — eso lo dice Chatwoot.
    const assigneeUnknown = command.assigneeName === undefined;
    if (assigneeUnknown) {
      // eslint-disable-next-line no-console
      console.warn('[assistant] el payload no trae `assigneeName` — se asume ASIGNADO (fail-closed)', {
        conversationId: command.conversationId,
      });
    }
    const assignedToHuman = assigneeUnknown || (command.assigneeName ?? '').trim().length > 0;
    const activity = evaluateAgentActivity(rawThread, {
      now: this.options.now?.(),
      windowMinutes: this.options.agentActiveWindowMinutes,
    });
    if (assignedToHuman || !activity.proceed) {
      return {
        outcome: 'noop',
        reason: 'agent_active',
        profileId: activeProfile.id,
        areaId: route.areaId,
      };
    }

    const enabledIntents = await this.intents.listEnabledByProfileId(activeProfile.id);

    let workingProfile = activeProfile;
    let workingAreaId = route.areaId;
    let intent: AssistantIntent | null = null;
    // Motivo que queda en `AssistantRun.reason` cuando la intención NO la eligió el modelo.
    let preReason: string | null = null;

    // ── Etapa 1c — pre-chequeo determinístico (RTR-4 / D5 / D11) ────────────
    const lastCustomer = lastCustomerMessage(rawThread);
    const lastCustomerText = lastCustomer?.text ?? '';
    // D11 — EXCEPCIÓN DEL COMPROBANTE. Un adjunto `comprobante_<op>.*` es un hecho duro sobre
    // el NOMBRE del archivo, no un `triggerPattern`: por eso no relaja CFG-2. Y le gana a
    // `promesa_pago`, porque "te paso el comprobante y el resto a fin de mes" trae un pago YA
    // hecho que hay que verificar antes de tratarlo como una promesa a futuro.
    const comprobanteOperacion = extractComprobanteOperacion(lastCustomer?.attachmentFilenames ?? []);

    // ⚠️ fix wave C1 — **los STOP se evalúan PRIMERO.** La versión anterior dejaba que un
    // adjunto `comprobante_*` desactivara TODOS los `triggerPatterns`: "ya pagué, te paso el
    // comprobante, pero hace 3 días que no tengo internet" + un PDF terminaba en un acuse de
    // cobranza, sin `soporte`, sin `necesita-humano` y sin que nadie se enterara. La excepción
    // del comprobante (D11) es acotada: le gana a `promesa_pago` —y sólo a ella—, porque "te
    // paso el comprobante y el resto a fin de mes" trae un pago YA hecho que hay que verificar
    // antes de tratarlo como una promesa a futuro. A un reclamo de servicio NO le gana nada.
    intent = matchTriggerIntent(lastCustomerText, enabledIntents);
    if (intent) preReason = 'trigger_pattern';

    if (comprobanteOperacion && (!intent || intent.roleKey === 'promesa_pago')) {
      const comprobanteIntent = findByRoleKey(enabledIntents, 'comprobante_mp');
      if (comprobanteIntent) {
        intent = comprobanteIntent;
        preReason = 'comprobante_attachment';
      }
    }

    // ── Etapa 2 — clasificar contra las intents del perfil (RTR-2) ───────────
    // Sólo si el pre-chequeo no decidió: una intención ya elegida por un hecho duro no se
    // somete a votación probabilística.
    if (!intent) {
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

      if (classification.kind === 'intent') {
        intent = enabledIntents.find((i) => i.id === classification.key) ?? null;
      }

      // ── Etapa 2b — re-ruteo (RTR-0) ───────────────────────────────────────
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
    }

    // ── Etapa 3 — ¿se puede ejecutar la acción? (ACT-1 + SEC-3) ──────────────
    // En modo CONVERSAR la acción es siempre responder: charlar es hablarle al cliente.
    let actionKey = intent?.actionKey ?? 'whatsapp_reply';
    const denied = await this.denyIfActionNotAllowed(command, workingProfile, actionKey, intent);
    if (denied) {
      return {
        ...denied,
        profileId: workingProfile.id,
        areaId: workingAreaId,
        intentName: intent?.name ?? null,
        actionKey,
      };
    }

    // ── Etapa 4 — hechos. En CONVERSAR: NINGUNO (CONV-2) ────────────────────
    const subject = {
      clientId: client.clientId,
      conversationId: command.conversationId,
      areaId: workingAreaId,
    };
    let resolved = intent
      ? await this.facts.execute(intent.dataSourceKeys, subject, client.identityValues)
      : { facts: {} as Record<string, unknown>, resolvedKeys: [] as string[] };

    // ── Etapa 4b — selector determinístico del comprobante (D11) ────────────
    // Las cuatro ramas las decide un booleano, un signo y un regex. Nada de eso se le delega
    // al modelo: el peor modo de falla —decirle "estás al día" a alguien que debe $72.589— no
    // puede depender de que el clasificador acierte.
    let extraLabels: string[] = [];
    if (intent && intent.dataSourceKeys.includes('cliente.recibos_hoy')) {
      const recibos = asRecord(resolved.facts['cliente.recibos_hoy']);
      const match = asRecord(recibos?.matchOperacion);
      const outcome = selectComprobanteOutcome(
        {
          recibosDisponible: recibos?.disponible === true,
          matchEncontrado: match?.encontrado === true,
          debt: debtFromSaldoFact(resolved.facts['cliente.saldo']),
          hasPromise: detectPaymentPromise(
            lastCustomerText,
            // INT-2 — la ÚNICA lista de frases de promesa es la de la fila `promesa_pago`.
            findByRoleKey(enabledIntents, 'promesa_pago')?.triggerPatterns ?? [],
          ),
          posibleDoblePago: recibos?.posibleDoblePago === true,
        },
        availableRoleKeys(enabledIntents),
      );

      if (outcome.kind === 'missing_role') {
        // La fila de destino no existe o está apagada ⇒ NO se inventa comportamiento.
        await this.markNeedsHuman(
          command.conversationId,
          workingProfile,
          'no pude resolver el comprobante: ' + outcome.reason,
          intent,
          // El label de área ya calculado (p. ej. `administracion` por doble pago) también
          // tiene que quedar: la conversación va a la MISMA cola aunque el rol falte.
          extraLabels,
        );
        return {
          outcome: 'handoff',
          reason: 'missing_role_key',
          profileId: workingProfile.id,
          areaId: workingAreaId,
          intentName: intent.name,
          dataSources: resolved.resolvedKeys,
          actionKey,
        };
      }

      extraLabels = outcome.extraLabels;
      const target = findByRoleKey(enabledIntents, outcome.roleKey);
      if (target && target.id !== intent.id) {
        intent = target;
        // Sólo se resuelven las fuentes que FALTAN: re-resolver todo dispararía una segunda
        // llamada en vivo a GR (`cliente.recibos_hoy`) dentro de la misma corrida, y el saldo
        // y el recibo tienen que venir del mismo instante (D11, segundo riesgo).
        resolved = await this.resolveMissing(resolved, intent.dataSourceKeys, subject, client.identityValues);

        if (intent.actionKey !== actionKey) {
          actionKey = intent.actionKey;
          const deniedAfter = await this.denyIfActionNotAllowed(
            command,
            workingProfile,
            actionKey,
            intent,
            extraLabels,
          );
          if (deniedAfter) {
            return {
              ...deniedAfter,
              profileId: workingProfile.id,
              areaId: workingAreaId,
              intentName: intent.name,
              actionKey,
            };
          }
        }
      }
    }

    const base = {
      profileId: workingProfile.id,
      areaId: workingAreaId,
      intentName: intent?.name ?? null,
      dataSources: resolved.resolvedKeys,
      actionKey,
    };


    // ── Etapa 5-pre — `handoff`: se deriva ANTES de redactar ────────────────
    // Un STOP no tiene nada que escribirle al cliente, así que no se le pide texto al modelo:
    // sería gastar una llamada (y una superficie de alucinación) para tirarla. También evita
    // que SEC-4 rechace una respuesta que igual no se iba a enviar y enmascare el motivo real
    // del handoff en `AssistantRun.reason`.
    if (actionKey === 'handoff') {
      // ── W10 (decisión del dueño, 2026-09-05) ──────────────────────────────
      // `comprobante_transferencia` NO puede ser un handoff MUDO: el cliente mandó un
      // comprobante y merece un acuse. La derivación no cambia (label `administracion` +
      // unassign + nota privada); lo que se agrega es la respuesta determinística, escrita
      // por código porque promete una imputación manual y menciona plata.
      if (intent?.roleKey === 'comprobante_transferencia') {
        await this.replyTransferAcknowledgement(command, workingProfile, {
          operacion: comprobanteOperacion,
          facts: resolved.facts,
        });
      }

      await this.safely(() =>
        this.gateway.privateNote(
          command.conversationId,
          ('🤖 STOP: ' + (intent?.name ?? 'derivación') + '. ' + workingProfile.handoffMessage).trim(),
        ),
      );
      await this.applyTrace(command.conversationId, intent, extraLabels, true);
      return { ...base, outcome: 'handoff', reason: preReason };
    }

    // ── Etapa 5 — redactar ──────────────────────────────────────────────────
    const generated = await this.runtime.generate({
      model: workingProfile.model,
      persona: workingProfile.persona,
      responseGuide: intent?.responseGuide ?? '',
      thread,
      // `null` marca modo CONVERSAR: sin hechos, el whitelist de SEC-4 queda vacío.
      // `toPublicFacts` saca los hechos INTERNOS (prefijo `_`): existen para el renderizado
      // determinístico, y nunca pueden llegar ni al prompt ni al whitelist (fix wave C4).
      facts: intent ? toPublicFacts(resolved.facts) : null,
      timeoutMs: workingProfile.timeoutMs,
    });

    if (generated.kind === 'unavailable') {
      await this.markNeedsHuman(
        command.conversationId,
        workingProfile,
        'no pude redactar la respuesta',
        intent,
        extraLabels,
      );
      return { ...base, outcome: 'error', reason: 'generator_unavailable' };
    }
    if (generated.kind === 'cannot_answer') {
      // El propio modelo pidió handoff (centinela NO_PUEDO_RESPONDER, D8).
      await this.markNeedsHuman(
        command.conversationId,
        workingProfile,
        'el asistente no supo responder',
        intent,
        extraLabels,
      );
      return { ...base, outcome: 'handoff', reason: 'model_cannot_answer' };
    }

    // ── Etapa 6 — SEC-4: ¿inventó algún número? ──────────────────────────────
    // Corre sobre `generated.text` SOLO. Lo que se anexa en 6b es determinístico: sale de los
    // hechos sin pasar por el modelo, así que meterlo en el whitelist sería relajar el
    // verificador en lugar de usarlo (D3).
    const whitelist = buildNumberWhitelist({
      facts: intent ? toPublicFacts(resolved.facts) : {},
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
        intent,
        extraLabels,
      );
      return { ...base, outcome: 'rejected_numbers', reason: 'number_not_in_facts' };
    }

    // ── Etapa 6a-bis — SEC-4 de FRASE (fix wave C5) ─────────────────────────
    // SEC-4 sólo mira números: "Estás al día, no tenés facturas pendientes" no tiene un solo
    // dígito y pasaba entero sobre un cliente que debe $72.589 — y encima se CONCATENA con el
    // bloque determinístico, que dice lo contrario en el renglón siguiente. Si el texto del
    // modelo contradice el signo del saldo de ESTA corrida, se descarta el texto (no la
    // corrida): lo determinístico, que sale de los hechos, alcanza para responder.
    const debtNow = debtFromSaldoFact(resolved.facts['cliente.saldo']);
    const modelText = contradictsBalanceState(generated.text, debtNow) ? '' : generated.text;

    // ── Etapa 6b — bloques DETERMINÍSTICOS, anexados DESPUÉS de SEC-4 (D3) ──
    const text = appendDeterministicBlocks(modelText, resolved.facts);

    if (text.trim().length === 0) {
      // El modelo contradijo los hechos y no hay bloque determinístico que rescate el turno:
      // no se envía nada y queda para un humano. Callarse es recuperable; afirmarle a alguien
      // que está al día cuando debe, no.
      await this.markNeedsHuman(
        command.conversationId,
        workingProfile,
        'descarté una respuesta que contradecía el saldo del cliente',
        intent,
        extraLabels,
      );
      return { ...base, outcome: 'handoff', reason: 'contradicts_balance' };
    }

    // ── Etapa 7 — ejecutar (6c — split ≤1400 e iteración SECUENCIAL) ────────
    // 6c — split ≤1400 e iteración SECUENCIAL. El puerto NO cambia (D3): `reply`/`privateNote`
    // se llaman N veces, en orden.
    const chunks = splitForWhatsapp(text);
    let sent = 0;
    try {
      for (const chunk of chunks) {
        await this.executeAction(command.conversationId, actionKey, chunk, workingAreaId);
        sent += 1;
      }
    } catch (err) {
      // Se cortó a mitad de camino: el cliente quedó con MEDIA respuesta. Eso NO puede
      // degradar a un `safely` mudo — un humano tiene que saber dónde retomar. Si no salió
      // ni el primer chunk no hay media respuesta que explicar: se propaga al manejo de
      // siempre (RUN-1), que ya deja label + nota.
      if (sent === 0) throw err;
      await this.safely(() =>
        this.gateway.privateNote(
          command.conversationId,
          '🤖 envié ' + sent + ' de ' + chunks.length + ' mensajes, seguí vos.',
        ),
      );
      // fix wave W7 — media respuesta NO es "el bot respondió": es un turno que un humano
      // tiene que retomar. `necesita-humano`, nunca `bot-respondió`.
      await this.applyTrace(command.conversationId, intent, extraLabels, true);
      return { ...base, outcome: 'error', reason: 'partial_send' };
    }

    await this.applyTrace(command.conversationId, intent, extraLabels, false);
    return { ...base, outcome: 'replied', reason: preReason };
  }

  /**
   * ACT-3 + ACT-4 (D10) — el rastro sobre la CONVERSACIÓN, después de la acción y para
   * CUALQUIER `actionKey`.
   *
   * Etiquetar y desasignar son efectos sobre la conversación, ortogonales a qué se le dijo al
   * cliente. Modelarlos como acciones compuestas (`reply_and_handoff`, …) habría duplicado el
   * catálogo por cada combinación y devuelto vocabulario al código (D10).
   *
   * El ORDEN importa: acción → labels → unassign. Al revés, si el envío falla la conversación
   * queda huérfana y sin explicación. Cada paso es `safely`: un fallo de label o de unassign
   * JAMÁS tumba un mensaje ya enviado (RUN-1).
   */
  private async applyTrace(
    conversationId: string,
    intent: AssistantIntent | null,
    extraLabels: string[],
    isHandoff: boolean,
  ): Promise<void> {
    const labels = unique([
      ...(isHandoff ? [ASSISTANT_LABEL_NEEDS_HUMAN] : [ASSISTANT_LABEL_REPLIED]),
      ...(intent?.labels ?? []),
      ...extraLabels,
    ]);
    await this.safely(() => this.gateway.applyLabels(conversationId, labels));

    if (intent?.unassign) {
      await this.safely(() => this.gateway.unassign(conversationId));
    }
  }

  /** ACT-1 + SEC-3 — devuelve el registro de handoff si la acción no se puede ejecutar. */
  private async denyIfActionNotAllowed(
    command: ReplyWithAssistantCommand,
    profile: AssistantProfile,
    actionKey: string,
    /** fix wave W3 — ACT-3: los labels y el unassign de la intent también aplican acá. */
    intent?: AssistantIntent | null,
    extraLabels: string[] = [],
  ): Promise<Pick<RunRecord, 'outcome' | 'reason'> | null> {
    const permission = evaluateActionPermission({
      actionKey,
      enabledActions: profile.enabledActions,
      canReply: command.canReply,
    });
    if (permission.allowed) return null;

    await this.markNeedsHuman(
      command.conversationId,
      profile,
      permission.reason === 'outside_reply_window'
        ? 'llegó una consulta fuera de la ventana de 24 h'
        : 'la acción necesaria no está habilitada',
      intent,
      extraLabels,
    );
    return { outcome: 'handoff', reason: permission.reason };
  }

  /** Resuelve SÓLO las fuentes que faltan y las mergea — cero llamadas repetidas a GR. */
  private async resolveMissing(
    current: { facts: Record<string, unknown>; resolvedKeys: string[] },
    keys: string[],
    subject: { clientId: string | null; conversationId: string; areaId: string },
    identityValues: string[],
  ): Promise<{ facts: Record<string, unknown>; resolvedKeys: string[] }> {
    const missing = keys.filter((k) => !current.resolvedKeys.includes(k));
    if (missing.length === 0) return current;

    const extra = await this.facts.execute(missing, subject, identityValues);
    return {
      facts: { ...current.facts, ...extra.facts },
      resolvedKeys: [...current.resolvedKeys, ...extra.resolvedKeys],
    };
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
    /**
     * fix wave W3 — ACT-3 dice que los efectos sobre la conversación aplican para CUALQUIER
     * acción, y un handoff por número inventado o fuera de ventana es tan "conversación que
     * hay que rutear" como uno por `triggerPattern`. Antes salía sólo `necesita-humano`: la
     * conversación quedaba sin el label de área (`administracion`/`soporte`) y ASIGNADA al
     * bot, o sea, invisible para la cola que tenía que atenderla.
     */
    intent?: AssistantIntent | null,
    extraLabels: string[] = [],
  ): Promise<void> {
    await this.safely(() =>
      this.gateway.privateNote(conversationId, `🤖 ${reason}. ${profile.handoffMessage}`.trim()),
    );
    await this.applyTrace(conversationId, intent ?? null, extraLabels, true);
  }

  /**
   * fix wave W10 (decisión del dueño 2026-09-05) — el acuse del comprobante de TRANSFERENCIA.
   *
   * Se envía además del handoff, no en lugar de él. Tres gates antes de hablar:
   *  1. `whatsapp_reply` habilitada en el perfil (ACT-1 / DFT-1: el modo borrador manda);
   *  2. la ventana de 24 h (SEC-3) — fuera de ella no se le puede escribir al cliente;
   *  3. `safely` — un fallo del envío NO puede impedir la nota privada ni el label, que son
   *     lo que hace que un humano se entere.
   */
  private async replyTransferAcknowledgement(
    command: ReplyWithAssistantCommand,
    profile: AssistantProfile,
    input: { operacion: string | null; facts: Record<string, unknown> },
  ): Promise<void> {
    if (!profile.enabledActions.includes('whatsapp_reply') || !command.canReply) return;

    const recibos = asRecord(input.facts['cliente.recibos_hoy']);
    const match = asRecord(recibos?.matchOperacion);
    const texto = renderTransferAcknowledgement({
      operacion: input.operacion ?? (typeof match?.operacion === 'string' ? match.operacion : null),
      // N1 — el importe del pago NO se conoce en esta rama (por eso se llegó acá) y el MEDIO
      // tampoco: el acuse no afirma ninguno de los dos. El saldo va calificado como
      // pre-imputación, porque todavía incluye lo que el cliente acaba de mostrar.
      debt: debtFromSaldoFact(input.facts['cliente.saldo']),
    });

    await this.safely(async () => {
      for (const chunk of splitForWhatsapp(texto)) {
        await this.gateway.reply(command.conversationId, chunk);
      }
    });
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

/** El último mensaje del CLIENTE del tramo cargado — el que dispara todo el pre-chequeo. */
function lastCustomerMessage(thread: AssistantThreadMessage[]): AssistantThreadMessage | null {
  for (let i = thread.length - 1; i >= 0; i--) {
    if (thread[i].role === 'customer') return thread[i];
  }
  return null;
}

/** D11 — las intents del perfil, indexadas por su rol estable (no por `name`, que se renombra). */
function findByRoleKey(intents: AssistantIntent[], roleKey: string): AssistantIntent | null {
  return intents.find((i) => i.roleKey === roleKey) ?? null;
}

/** Roles disponibles = `roleKey` de las intents HABILITADAS de este perfil (D11). */
function availableRoleKeys(intents: AssistantIntent[]): string[] {
  return intents.map((i) => i.roleKey).filter((k): k is string => typeof k === 'string' && k.length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((v) => typeof v === 'string' && v.trim().length > 0)));
}

/**
 * D11/DFT-2 — el saldo de ESTA corrida, o `null`.
 *
 * `ClienteSaldoResolver` emite `saldo: 0` para TODO `balanceDue <= 0` (FW2-1 — el crédito
 * llega sin moneda y su cifra cruda whitelistearía "5000" para un "tenés una deuda de 5000").
 * Eso hacía INALCANZABLE la rama "saldo a favor" de RSP-1: el motor nunca podía ver un
 * `debt < 0`.
 *
 * fix wave C4 — el crédito viaja aparte, en el hecho INTERNO `_aFavor` (siempre positivo), que
 * `toPublicFacts` saca antes del prompt y antes del whitelist. Acá se lo vuelve a poner en
 * signo negativo, que es el vocabulario que entiende `renderBalanceSignMessage`. `saldo` sigue
 * en 0 para todos los demás consumidores: FW2-1 intacto.
 */
function debtFromSaldoFact(fact: unknown): number | null {
  const saldo = asRecord(fact);
  if (!saldo || saldo.disponible !== true) return null;

  const aFavor = Number(saldo._aFavor);
  if (Number.isFinite(aFavor) && aFavor > 0) return -aFavor;

  const value = Number(saldo.saldo);
  return Number.isFinite(value) ? value : null;
}

/**
 * ai-assistant-cobranzas (fix wave C4) — los hechos que SÍ pueden salir de este proceso.
 *
 * Convención: una clave que arranca con `_` es un hecho INTERNO — existe para el renderizado
 * determinístico del motor y NUNCA llega al modelo ni al whitelist del verificador de números.
 * Es la única forma de exponerle al código un dato (el importe a favor) que al prompt le hace
 * daño: en el prompt pierde el signo y la moneda, y en el whitelist AUTORIZA su propia cifra.
 */
export function toPublicFacts(facts: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(facts)) {
    if (key.startsWith('_')) continue;
    out[key] = scrubInternal(value);
  }
  return out;
}

/**
 * N1 del re-verify (N3) — **el filtro también entra a los ARRAYS.** La primera versión
 * devolvía el array tal cual, así que un `_loQueSea` dentro de `cliente.facturas.facturas[i]`
 * llegaba al prompt y al whitelist. Hoy ningún resolver emite `_` adentro de un array, pero un
 * invariante que dice "NUNCA llega al modelo" no puede depender de que nadie lo intente.
 */
function scrubInternal(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubInternal);
  const record = asRecord(value);
  return record ? toPublicFacts(record) : value;
}

/**
 * D3 + RSP-1 — lo que el CÓDIGO le agrega al texto del modelo, después de SEC-4.
 *
 * Dos bloques, los dos determinísticos (salen de los hechos de GR, sin intermediación del
 * modelo) y por eso anexados FUERA del verificador de números:
 *
 *  1. **El signo del saldo tras un pago verificado** (`renderBalanceSignMessage`): el recibo
 *     sólo DISPARA la verificación, nunca prueba por sí solo que la deuda quedó saldada. Si
 *     `cliente.saldo` no está disponible, no se afirma NADA (la función devuelve `null`).
 *  2. **El detalle de facturas con sus links** (`renderInvoiceBlock`): el modelo tiene
 *     prohibido escribir montos y links (SEC-4 los rechazaría por dígitos, y es justo la
 *     superficie de alucinación que el change cierra).
 */
function appendDeterministicBlocks(modelText: string, facts: Record<string, unknown>): string {
  const parts = [modelText.trim()];

  const recibos = asRecord(facts['cliente.recibos_hoy']);
  const match = asRecord(recibos?.matchOperacion);
  if (recibos?.disponible === true && match?.encontrado === true) {
    const balance = renderBalanceSignMessage({
      debt: debtFromSaldoFact(facts['cliente.saldo']),
      // C3 — `null` = NO SABEMOS cuántas facturas quedan (el camino normal cuando
      // `cliente.facturas` viene `{disponible:false}`). Con un 0 por defecto el bot mandaba
      // "te quedan $72.589,41 pendientes en 0 facturas".
      invoiceCount: invoiceCountFrom(facts['cliente.facturas']),
      // S2 — sin importe no se renderiza "$0,00".
      paidAmount: finiteOrNull(match.importe),
      posibleDoblePago: recibos.posibleDoblePago === true,
    });
    if (balance) parts.push(balance);
  }

  const block = invoiceBlockFrom(facts['cliente.facturas']);
  if (block) parts.push(block);

  return parts.filter((p) => p.length > 0).join('\n\n');
}

function invoiceBlockFrom(fact: unknown): string | null {
  const facturas = asRecord(fact);
  if (!facturas || facturas.disponible !== true) return null;
  const invoices = Array.isArray(facturas.facturas) ? (facturas.facturas as AssistantInvoiceFact[]) : [];

  return renderInvoiceBlock({
    invoices,
    totalPaymentUrl: typeof facturas.linkPagoTotal === 'string' ? facturas.linkPagoTotal : null,
    // fix wave W9 (REN-1) — el alias y su aclaración de titularidad estaban implementados en
    // `renderInvoiceBlock` y NUNCA se pasaban: código muerto, requisito incumplido.
    payByAlias: typeof facturas.aliasPago === 'string' ? facturas.aliasPago : null,
  });
}

/** C3 — conteo de facturas abiertas, o `null` si la fuente no lo sabe. */
function invoiceCountFrom(fact: unknown): number | null {
  const facturas = asRecord(fact);
  if (!facturas || facturas.disponible !== true) return null;
  const n = Number(facturas.cantidad);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** S2 — un número usable, o `null`. Un `0` NUNCA se renderiza como importe. */
function finiteOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
