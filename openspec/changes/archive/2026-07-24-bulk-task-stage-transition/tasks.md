# Tasks — bulk-task-stage-transition

TDD estricto (Jest + adapters in-memory, test primero). Gate del orquestador (suite + `tsc --noEmit`) tras cada batch.
Review adversarial → fix wave → re-review CLEAN antes del commit. Worktree `feat/bulk-task-stage-transition-be`.

## Batch 1 — Config singleton del estado resultante (aislado, cero riesgo) · specs TTC-1..4
- [ ] 1.1 Schema: `WhatsappTaskStageTransitionConfig` (singleton, `resultingStageId String?` FK `Stage` SetNull) + back-relation en `Stage`. Migración ADITIVA (`prisma migrate diff`).
- [ ] 1.2 Error `ResultingStageNotAllowedError` (`RESULTING_STAGE_NOT_ALLOWED`, 422) en `domain/errors/messaging-bulk.ts` + mapeo en `errorHandler`.
- [ ] 1.3 Port `TaskStageTransitionConfigRepository` (`getResultingStageId`/`getResultingStage`/`setResultingStageId`).
- [ ] 1.4 `InMemoryTaskStageTransitionConfigRepository` (test primero) — TTC-1/TTC-2 scenarios.
- [ ] 1.5 `PrismaTaskStageTransitionConfigRepository` (singleton upsert) + test de infra.
- [ ] 1.6 Use cases: `GetTaskStageTransitionConfig` + `SetTaskStageTransitionConfig` (valida no-`send_to_iclass` + id existente) — tests TTC-3.
- [ ] 1.7 Rutas: `GET /config/task-stages` extendido con `resultingStage`; `PUT /config/task-stages/resulting-stage` (gate `messaging.manage`) — supertest TTC-4.
- [ ] 1.8 Wiring `app.ts` + composition-root assert.

## Batch 2 — Resolución per-tarea · specs TASK-3/6/8 (MODIFIED)
- [ ] 2.1 Port `TaskRecipientSource.listOpenTasksByStages(stageIds) → {taskId,clientId,fromStageId}[]` (conservar los métodos existentes).
- [ ] 2.2 `InMemoryTaskRecipientSource` nuevo método (test primero) — 2 tareas mismo cliente → 2 filas.
- [ ] 2.3 `PrismaTaskRecipientSource` + índice `(stageId, generalStatus, customerId)` + test infra.
- [ ] 2.4 `resolveCombinedRecipients` branch task → per-tarea, sin dedup teléfono intra-task, snapshots `taskId/taskFromStageId/taskResultingStageId` (lee `resultingStageId` una vez), cap por-tarea. Tests TASK-3/6/8 reescritos.
- [ ] 2.5 `CombinedResolvedRecipient` gana `taskId?/taskFromStageId?/taskResultingStageId?`. Verificar cero regresión seg/manual/csv (suites sin editar aserciones).

## Batch 3 — Schema `CampaignRecipient` + migración destructiva · spec TRANS-5
- [ ] 3.1 Migración ADITIVA: columnas `taskId`(FK SetNull)/`taskFromStageId`/`taskResultingStageId`.
- [ ] 3.2 `CampaignRecipient` entity + `CampaignRepository` (bulkCreate + `listRecipientsKeyset` devuelven los campos task).
- [ ] 3.3 `InMemoryCampaignRepository` soporta los campos + relajar el dedup a per-taskId cuando aplica. Tests.
- [ ] 3.4 **Migración DESTRUCTIVA (a mano, SEPARADA):** drop `@@unique[campaignId,clientId]` → unique PARCIAL `(campaignId,taskId) WHERE taskId IS NOT NULL`. **REVISAR SQL COMPLETO CON EL USUARIO** + dry-run rolled-back vs prod ANTES del push.
- [ ] 3.5 `PrismaCampaignRepository.bulkCreateRecipients` persiste los campos task.

## Batch 4 — Transición en el envío · specs TRANS-1..4
- [ ] 4.1 Port `CampaignTaskTransitionPort` (`transition({taskId,fromStageId,toStageId}) → outcome`).
- [ ] 4.2 `TransitionTaskAfterSend` (guard still-in-A + guard anti-`send_to_iclass` + reusa `MoveTaskToStage`) — tests TRANS-2/3.
- [ ] 4.3 In-memory/fake del port para el test de `SendCampaign`.
- [ ] 4.4 `SendCampaign` 6º dep opcional `taskTransition` + `transitionTaskIfNeeded` post-`sent`, aislado/best-effort — tests TRANS-1/4 (OK→mueve, fail→no, move-throw→no re-marca).
- [ ] 4.5 Wiring `SendCampaign`/`CampaignRunner` en `app.ts` + composition-root test (lección W6).

## Batch 5 — Preview por-tarea · spec TRANS-6
- [ ] 5.1 `PreviewCampaignSegment`/`ListSegmentRecipients` cuentan tareas + flag de transición. Tests.

## Batch 6 — FE (sobre BE verde) · specs FE-TRANS-1..3
- [ ] 6.1 `ui-ux-pro-max --design-system` + Emil motion (obligatorio).
- [ ] 6.2 Card Config: `Select` propio de estado resultante (excluye `send_to_iclass`, "— Sin transición —") + `PUT` + confirm de impacto. Vitest test primero.
- [ ] 6.3 Preview/tab "Tarea": conteo por-tarea + hint de transición. Tests.
- [ ] 6.4 `review-animations` antes de mergear.

## Cierre
- [ ] Gate orquestador BE (suite + tsc) + FE (Vitest + tsc + build).
- [ ] Review adversarial (4 focos: migración destructiva · snapshot/idempotencia/guard · aislamiento best-effort · wiring/contrato) → fix wave → re-review CLEAN.
- [ ] Dry-run rolled-back de la migración destructiva vs prod.
- [ ] Actualizar card BACKLOG + engram. `sdd-verify` (matriz spec-compliance) → deploy (push confirmado) → `sdd-archive`.
