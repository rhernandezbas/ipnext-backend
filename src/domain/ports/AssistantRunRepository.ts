import type { AssistantOutcome, AssistantRun, AssistantSubjectType } from '@domain/entities/assistant';

/**
 * ai-assistant-multiagent (OBS-1) — auditoría de cada invocación del motor.
 *
 * ⚠️ El input NO declara ningún campo de contenido (ni el mensaje del cliente, ni el prompt,
 * ni la respuesta generada). No es un olvido: OBS-1 exige que la auditoría NO contenga PII
 * ni el prompt crudo. Se registra QUÉ pasó y POR QUÉ, nunca QUÉ SE DIJO — para eso está el
 * hilo de la conversación, que ya es la fuente de verdad del contenido.
 */
export interface RecordAssistantRunInput {
  profileId: string | null;
  areaId: string | null;
  subjectType: AssistantSubjectType;
  subjectId: string;
  /** `null` ⇒ el clasificador no matcheó ninguna intención habilitada (default deny). */
  intentName: string | null;
  dataSources: string[];
  actionKey: string | null;
  outcome: AssistantOutcome;
  /** Motivo corto y ACOTADO (`'flag_off'`, `'no_intent_match'`, …). Nunca contenido. */
  reason: string | null;
  latencyMs: number | null;
}

export interface ListAssistantRunsQuery {
  areaId?: string;
  outcome?: AssistantOutcome;
  subjectType?: AssistantSubjectType;
  subjectId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface AssistantRunRepository {
  /**
   * Registra la corrida. BEST-EFFORT en el call site: si esto falla, el motor NO debe
   * romperse (RUN-1) — la auditoría es importante, pero jamás al precio de tumbar el
   * webhook o la creación de un ticket.
   */
  record(input: RecordAssistantRunInput): Promise<AssistantRun>;
  list(query: ListAssistantRunsQuery): Promise<{ items: AssistantRun[]; total: number }>;

  /**
   * ANTI-RÁFAGA (review adversarial, 2026-07-26) — ¿el asistente ya le respondió a ESTA
   * conversación desde `sinceIso`?
   *
   * El escenario que ataja es el uso NORMAL de WhatsApp: el cliente manda "hola" / "quería
   * consultar" / "sobre mi factura" en cinco segundos. Chatwoot dispara TRES webhooks, cada
   * uno arranca el motor, y el cliente recibe tres respuestas pisándose. No es un caso de
   * borde: es cómo se usa el canal.
   *
   * Sólo cuentan los `replied`: un `handoff` o un `noop` previos no deben bloquear una
   * respuesta legítima al mensaje siguiente.
   */
  hasRepliedSince(conversationId: string, sinceIso: string): Promise<boolean>;
}
