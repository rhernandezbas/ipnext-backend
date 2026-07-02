# Tasks: PPPoE bulk change-plan — timeout de lotes + mensaje de corte falso

> TDD estricto (red → green → refactor). Worktree `bulk-batch-fix-fe` (`ipnext-frontend`). Solo FE — NO tocar `MoveNasModal`/`GestionRedPage`/BE. NO build/commit/push.

## 1. `src/utils/pppoeBulkBatches.ts`

- [ ] 1.1 **(test primero)** `chunkIds` con tamaño 25: 26 ids → 2 lotes (25+1); 25 ids → 1 lote de 25; 24 ids → 1 lote de 24.
- [ ] 1.2 **(test primero)** `runPppoeBulkBatches` sin `batchSize` explícito usa el default nuevo (25), no 200.
- [ ] 1.3 **(test primero)** el resultado de un corte por rechazo de transporte incluye `unconfirmed` = los ids exactos del lote rechazado; sin corte, `unconfirmed = []`.
- [ ] 1.4 **(green)** exportar `BULK_BATCH_SIZE = 25`; agregar `unconfirmed: string[]` a `RunPppoeBulkBatchesResult`; poblarlo en la rama `catch` con `batchIds`; default `opts.batchSize ?? BULK_BATCH_SIZE`.
- [ ] 1.5 Actualizar el JSDoc de cabecera del archivo (ya no dice "lotes de <=200 por default").

## 2. `src/pages/networking/PppoeManagementTab.tsx`

- [ ] 2.1 **(test primero, `PppoeManagementTab.bulk.test.tsx`)** reescribir HONESTAMENTE los tests que asumían lotes de 200 (toolbar "lotes de 200", assertions de 2 requests de 200/140, etc.) para reflejar lotes de 25 — nombrar el cambio de spec en el comentario del test, no borrar cobertura.
- [ ] 2.2 **(test primero)** selección de 26-200 (ej. 150) ya NO usa el camino directo (`bulkMutation`) — usa el orquestador de lotes (`batchMutation`) con `batchSize=25`.
- [ ] 2.3 **(test primero)** mensaje de corte honesto: NO contiene "se aplicaron 0"/"aplicados"; SÍ contiene "no obtuvo respuesta", "pueden haberse aplicado" y "confirmados" en los conteos.
- [ ] 2.4 **(test primero)** selección post-corte = `unconfirmed` + no-enviados (los `ok` se limpian) — pin de invariante ya existente, verificar que sigue sosteniéndose con lotes de 25.
- [ ] 2.5 **(green)** importar `BULK_BATCH_SIZE`; cambiar el umbral directo/lotes de `handleBulkConfirm` a `ids.length <= BULK_BATCH_SIZE`; `totalBatches = Math.ceil(selected.size / BULK_BATCH_SIZE)`; toolbar con el texto nuevo. `BULK_SELECTION_CAP` (200) queda intacto para el checkbox de confirmación.
- [ ] 2.6 **(green)** nuevo estado `batchUnconfirmed` (reset en abrir/cerrar modal, seteado desde `result.unconfirmed` al terminar/cortar la corrida); prop nueva en `BulkChangePlanModal`.
- [ ] 2.7 **(green)** reescribir el copy del bloque `cut &&` en `BulkChangePlanModal` con el mensaje honesto (español claro, sin tecnicismos de transporte).

## 3. Verificación

- [ ] 3.1 `TZ=UTC npx vitest run src/__tests__/networking/ src/__tests__/utils/ --silent` — números reales, sin skips.
- [ ] 3.2 `tsc --noEmit` (con `NODE_OPTIONS=--max-old-space-size=6144`) limpio.
- [ ] 3.3 Reporte final: fixes aplicados, archivos tocados, números de test/typecheck, desvíos respecto a este plan (si los hubo).

## Fuera de scope (registrado)

- BE: `MAX_BULK_IDS=200`, el endpoint `POST /pppoe/bulk/change-plan`, cualquier ajuste de proxy/timeout de infraestructura.
- `MoveNasModal`, `GestionRedPage`.
- Build, commit, push.

---

## 4. Ola 2 (pedido del usuario 2026-07-02): "esto hazlo async, y que se pueda cortar todos"

> Sobre el mismo worktree `bulk-batch-fix-fe`, encima de la ola 1 ya en limpio (sin commitear). TDD estricto. Solo FE — mismos archivos que ola 1. NO tocar `MoveNasModal`/`GestionRedPage`/BE. NO build/commit/push.

### 4.1 `src/utils/pppoeBulkBatches.ts` — cancelación real

- [x] 4.1.1 **(test primero)** `shouldCancel` se chequea ANTES de mandar cada lote, incluido el primero: si ya es `true` desde el arranque, no se manda ningún lote (`cancelled.atBatch=1`).
- [x] 4.1.2 **(test primero)** 4 lotes, cancela DESPUÉS de que el 2º resuelva → se envían 2, `cancelled = { atBatch: 3, totalBatches: 4 }`, `ok`/`failed` solo de los 2 lotes enviados.
- [x] 4.1.3 **(test primero)** interacción cancel+cut: el lote en vuelo rechaza por transporte MIENTRAS `shouldCancel` ya es `true` → el resultado tiene `cut`+`unconfirmed` Y `cancelled`, sobre el MISMO lote.
- [x] 4.1.4 **(test primero)** `shouldCancel` se chequea ANTES de `onProgress`/`sendBatch` — si ya está cancelado, ninguno de los dos se llama para ese lote.
- [x] 4.1.5 **(green)** `opts.shouldCancel?: () => boolean`; nueva interfaz `PppoeBulkBatchCancelled { atBatch, totalBatches }`; campo `cancelled: PppoeBulkBatchCancelled | null` en `RunPppoeBulkBatchesResult`; chequeo al tope del loop (antes de `onProgress`/`sendBatch`) y chequeo extra dentro del `catch` (para el caso cancel+cut).
- [x] 4.1.6 Actualizar el JSDoc de cabecera del archivo con la semántica de `cancelled` y la interacción cancel+cut.

### 4.2 `src/pages/networking/PppoeManagementTab.tsx` — UI de cancelación + segundo plano

- [x] 4.2.1 **(test primero, reescritura HONESTA de W2)** el test viejo "'Cancelar' disabled durante TODA la corrida en lotes" YA NO APLICA para el camino en lotes — se reemplaza por: durante el envío en lotes, "Cancelar" no existe más; aparecen "Continuar en segundo plano" (habilitado) y "Cortar" (habilitado).
- [x] 4.2.2 **(test primero, pin de invariante)** el camino DIRECTO (`<=BULK_BATCH_SIZE`) queda INTACTO: "Cancelar" sigue disabled durante el envío, sin "Cortar" ni "Continuar en segundo plano".
- [x] 4.2.3 **(test primero)** botón "Cortar" real: click → flag → "Cortando… (termina el lote en vuelo)" (disabled) → el próximo lote NUNCA se manda → resumen "Corrida cortada en el lote N de X. Confirmados: A ok, B fallidos." → los no-enviados siguen seleccionados.
- [x] 4.2.4 **(test primero)** "Continuar en segundo plano" cierra el modal SIN abortar la corrida — el chip (arriba de la tabla) muestra el progreso en vivo ("Cambiando plan: lote N/X", `aria-live="polite"`).
- [x] 4.2.5 **(test primero)** "Cortar" desde el chip (modal cerrado) corta la corrida igual que desde el modal.
- [x] 4.2.6 **(test primero)** al terminar en background (completa, cortada o cancelada), el chip es reemplazado por un banner de resumen con "Ver detalle" (reabre el modal mostrando el `result` ya poblado) y "Descartar" (limpia todo el estado).
- [x] 4.2.7 **(test primero)** cut+cancelled combinados: el mensaje del modal prioriza el texto de `cut` (más grave) y suma la nota de corte manual; NO debe aparecer el mensaje de cancelación pura en ese caso.
- [x] 4.2.8 **(test primero)** mientras hay una corrida en curso (incluso en background), "Cambiar plan" de la toolbar de selección queda deshabilitado con `title` explicativo; se rehabilita al terminar.
- [x] 4.2.9 **(test primero)** accesibilidad: chip/banner con `role="status"`, texto de progreso con `aria-live="polite"` explícito, botones con labels de texto claro (sin iconos mudos).
- [x] 4.2.10 **(green)** nuevo estado (`isCancelling`, `batchCancelled`, ref `cancelRequestedRef`); handlers `handleCancelRun`, `handleBackgroundContinue`, `handleReopenBulkModal`; `handleBulkConfirm` pasa `shouldCancel: () => cancelRequestedRef.current` SOLO en el camino de lotes; reset de los 3 en `handleOpenBulkModal`/`handleCloseBulkModal`/al terminar (`finally`).
- [x] 4.2.11 **(green)** `BulkChangePlanModal` gana props `cancelled`, `isBatching`, `isCancelling`, `onCancelRun`, `onBackground`; el bloque de acciones bifurca por `isPending && isBatching` (Continuar+Cortar) vs. el resto (Cancelar, comportamiento intacto); nuevo bloque `!cut && cancelled &&` para el mensaje de cancelación pura, y nota adicional en el bloque `cut &&` cuando `cancelled` también está presente.
- [x] 4.2.12 **(green)** chip (`.bulkChip`) y banner (`.bulkBanner`) nuevos, renderizados fuera del modal (zona de la toolbar/tabla), gateados por `isBulkRunning`/`showBulkModal`/`bulkResult`; botón "Cambiar plan" de la toolbar con `disabled={isBulkRunning}` + `title`.
- [x] 4.2.13 Documentar como comentario en el código el límite conocido: si el operador navega fuera del tab durante la corrida, el resumen se pierde (el estado no sobrevive al desmontaje) — fuera de alcance recuperarlo.

### 4.3 Verificación ola 2

- [x] 4.3.1 `TZ=UTC npx vitest run src/__tests__/networking/ src/__tests__/utils/ --silent` — 510/510 verde, sin skips.
- [x] 4.3.2 `tsc --noEmit` (con `NODE_OPTIONS=--max-old-space-size=6144`) limpio (exit 0).
- [x] 4.3.3 Reporte final: fixes aplicados, archivos tocados, números de test/typecheck, desvíos respecto a este plan.

### Fuera de scope ola 2 (registrado)

- Recuperar el resumen/progreso si el operador navega fuera del tab durante la corrida (límite conocido, documentado, NO resuelto en esta ola).
- BE, `MoveNasModal`, `GestionRedPage` — igual que ola 1.
- Build, commit, push.
