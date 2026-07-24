import type { CampaignSegmentSource, ManualRecipientSource } from '@domain/ports/CustomerRepository';
import type { TaskRecipientSource } from '@domain/ports/TaskRecipientSource';
import type { TaskStageRecipientConfigRepository } from '@domain/ports/TaskStageRecipientConfigRepository';
import type { TaskStageTransitionConfigRepository } from '@domain/ports/TaskStageTransitionConfigRepository';
import type { PreviewSegmentInput, PreviewSegmentOutput } from '@application/dto/messaging-bulk.dto';
import { assertHasRecipients } from './assertHasRecipients';
import { assertTaskStagesEligible } from './assertTaskStagesEligible';
import { resolveCombinedRecipients, normalizeManualClientIds, normalizeManualContacts } from './resolveCombinedRecipients';

/** Muestra acotada del preview (design §3.2) — no es el `count` real, solo una vidriera. */
const SAMPLE_SIZE = 20;

/**
 * messaging-bulk (F2, SEG-1..SEG-5) — a.k.a. `CountRecipients`. Resuelve el
 * segmento de solo-lectura: delega la resolución narrow en
 * `CampaignSegmentSource.listSegmentRecipients` (status IN + rango balanceDue,
 * SEG-1) y aplica `resolveRecipients` (SEG-2 opt-out / SEG-3 de-dup / SEG-4
 * teléfono inválido) en memoria.
 *
 * SEG-5 — de solo lectura por construcción: este use case NO recibe ningún
 * `CampaignRepository`, no puede persistir nada aunque quisiera.
 *
 * Gate RBAC `messaging.bulk` se aplica en la ruta (Batch 7), no acá.
 */
export class PreviewCampaignSegment {
  constructor(
    private readonly segmentSource: CampaignSegmentSource,
    // manual-recipients (MAN-5) — OPCIONAL: los tests/wiring segment-only quedan
    // intactos (1 arg). Requerido solo cuando el input trae `manualClientIds`.
    private readonly manualRecipientSource?: ManualRecipientSource,
    // bulk-task-recipients (D3, D5) — 2 args OPCIONALES nuevos AL FINAL (molde
    // `manualRecipientSource`, no rompen la aridad de los tests ya verdes).
    private readonly taskRecipientSource?: TaskRecipientSource,
    private readonly taskStageConfigRepo?: TaskStageRecipientConfigRepository,
    // bulk-task-stage-transition (TRANS-6) — para el hint "N tareas transicionarán".
    private readonly taskTransitionConfig?: TaskStageTransitionConfigRepository,
  ) {}

  async execute(input: PreviewSegmentInput): Promise<PreviewSegmentOutput> {
    // manual-recipients (MAN-5) — lista manual normalizada (dedup + sin vacíos).
    const manualClientIds = normalizeManualClientIds(input.manualClientIds);
    // bulk-csv-recipients (CSV-6) — 4to dominio normalizado.
    const manualContacts = normalizeManualContacts(input.manualContacts);
    // bulk-task-recipients (TASK-1) — 5to dominio, PARALELO.
    const taskStageIds = input.taskStageIds ?? [];

    // MAN-2 (extiende FIX-8) — válido con segmento filtrado, O lista manual no
    // vacía, O manualContacts no vacío, O taskStageIds no vacío; rechaza ANTES
    // de tocar la fuente si los CUATRO están vacíos.
    assertHasRecipients(input, manualClientIds, manualContacts, taskStageIds);
    // bulk-task-recipients (TASK-2, D3) — elegibilidad ANTES de resolver clientes.
    await assertTaskStagesEligible(taskStageIds, this.taskStageConfigRepo);

    // MAN-5 + bulk-csv-recipients (CSV-6) + bulk-task-recipients (TASK-7) —
    // cuenta la UNIÓN (segmento ∪ manuales ∪ CSV ∪ tarea) deduplicada por
    // clientId Y por teléfono (FIX-1/CSV-4). `skipped` RECONCILIA las
    // exclusiones de las 4 fuentes (opt-out/teléfono-inválido/duplicate-phone),
    // sin doble-contar el overlap. Invariante: count (enviables) + Σ skipped =
    // destinatarios únicos considerados.
    const { resolved, segmentSkipped, manualSkipped, csvSkipped, taskSkipped, statusCounts, noCustomerCount } =
      await resolveCombinedRecipients({
        segment: input,
        manualClientIds,
        manualContacts,
        taskStageIds,
        segmentSource: this.segmentSource,
        manualRecipientSource: this.manualRecipientSource,
        taskRecipientSource: this.taskRecipientSource,
        taskTransitionConfig: this.taskTransitionConfig,
      });

    // bulk-task-stage-transition (TRANS-6) — cuántas TAREAS transicionarán de estado al
    // enviar (recipients source:'task' con un destino B snapshoteado). 0 si no hay destino
    // configurado o no hay dominio tarea.
    const taskWillTransitionCount = resolved.filter(
      (r) => r.source === 'task' && r.taskResultingStageId != null,
    ).length;

    return {
      count: resolved.length,
      taskWillTransitionCount,
      sample: resolved.slice(0, SAMPLE_SIZE).map((r) => ({
        clientId: r.clientId,
        name: r.name,
        phoneE164: r.phoneE164,
        status: r.status,
      })),
      skipped: {
        optedOut: segmentSkipped.optedOut + manualSkipped.optedOut + csvSkipped.optedOut + taskSkipped.optedOut,
        duplicatePhone:
          segmentSkipped.duplicatePhone + manualSkipped.duplicatePhone + csvSkipped.duplicatePhone + taskSkipped.duplicatePhone,
        invalidPhone:
          segmentSkipped.invalidPhone + manualSkipped.invalidPhone + csvSkipped.invalidPhone + taskSkipped.invalidPhone,
      },
      statusCounts,
      noCustomerCount,
    };
  }
}
