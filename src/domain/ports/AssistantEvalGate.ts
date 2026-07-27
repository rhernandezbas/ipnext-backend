/**
 * ai-assistant-multiagent (EVAL-2) — candado de las acciones de riesgo `red`.
 *
 * `close_ticket` entierra un problema que quizá seguía vivo; `create_task` despacha una
 * cuadrilla y eso cuesta combustible y horas. Ninguna de las dos se prende sin una corrida
 * de evaluación registrada: se habilitan con datos, no con entusiasmo.
 *
 * Port MÍNIMO a propósito. La implementación real (Batch 8) consulta las corridas de eval
 * persistidas; acá sólo interesa la pregunta binaria, para que la capa de configuración no
 * dependa de la forma del reporte de evaluación.
 */
export interface AssistantEvalGate {
  /**
   * ¿Existe al menos una corrida de eval registrada que habilite prender acciones de alto
   * riesgo? Ante la duda MUST devolver `false`: el default seguro es NO habilitar.
   */
  hasRecordedRun(): Promise<boolean>;
}
