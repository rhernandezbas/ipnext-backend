# Archive Report — audit-degeneration-retry (#34)

**Archived**: 2026-06-08. Deployed to prod (BE PR #80, container boot confirmed). No migration. BE-only.

## Disparador / diagnóstico
Con el reprocess drenando (#23/#32/#33 + flags ON + Ollama), algunas OS multi-foto **degeneraban**: `qwen2.5vl:7b` devuelve tokens basura repetidos (`<|im_start|>` en loop) en vez de JSON → `parseAuditResult` soft-fail → `{ok:false}` → la audit no se persiste, la OS queda pendiente, y el próximo reprocess manda las MISMAS 8 fotos → degenera igual (los 3 `auditAttempts` se desperdician). Visto en prod: OS 4564 (3 fotos) degenera, OS 4563 (4 fotos) anda.

## Pivot de enfoque (feedback del usuario)
La primera idea —una **escalera que tiraba fotos** (8→3→0)— se descartó: las fotos SON contexto, tirarlas pierde la info que el audit necesita. El usuario propuso usar las 8 pero **1x1**, ya que son contexto. Se rehízo la planificación (re-propose/spec/design/tasks) con un enfoque map-reduce. Decisión de timing confirmada por el usuario: full-8 primero, 1x1 solo si degenera.

## Fix (map-reduce)
- **Attempt 1** (sin cambios): una llamada multimodal con las 8 fotos + `format: auditFormatSchema()` + `temperature:0` → si parsea, devuelve. Rápido, anda para la mayoría.
- **Si degenera** (parse soft-fail con fotos + flag `mapReduceOnDegeneration` ON):
  - **MAP**: cada foto 1x1, una llamada con esa sola imagen + `renderPhotoDescribePrompt()` (texto libre, SIN schema) → observación por foto.
  - **REDUCE**: una llamada **solo texto** (images:[]) con `renderSynthesisPrompt(ctx, observaciones)` + schema → los hallazgos. Si la síntesis igual falla → `{ok:false}` (los `auditAttempts` siguen de última red).
- Fotos descargadas una sola vez y reusadas. `maxPhotos` se queda en 8. `renderPrompt`/`parseAuditResult`/`auditFormatSchema` intactos.

## Ciclo SDD (con pivot)
propose(ladder) → ... → apply(ladder, FRENADO por feedback) → re-propose(map-reduce) → spec ∥ design → tasks → apply (22/22) → verify PASS 11/11 → archive. Suite 2537/0, tsc limpio.

## Desviación (aceptable)
Jimp usa dynamic imports que rompen en Jest → `fetchB64` pasó de `private` a `protected` para poder mockearlo con `jest.spyOn`. Es compile-time only; el path de Jimp+fetch en producción queda **intacto**.

## Archivos
BE: `src/infrastructure/adapters/audit/OllamaInstallationAuditor.ts` (+map-reduce, 2 prompts nuevos, toggle `useSchema` en `ask`) + su test (14 tests nuevos).

## Efecto en prod
Las OS que degeneraban ahora se rescatan: si el prompt completo rompe, se analizan las 8 fotos 1x1 + síntesis — **sin perder ni una**. Las tercas pendientes deberían empezar a completar.
