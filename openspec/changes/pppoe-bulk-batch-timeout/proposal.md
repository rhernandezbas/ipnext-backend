# Proposal: PPPoE bulk change-plan — timeout de lotes largos + mensaje de corte falso

## Intent

Fix chico sobre el flujo de bulk change-plan de PPPoE (`pppoe-bulk-select-filter` v2, EN PROD): reduce el tamaño de lote (200 → 25) para que ningún lote tarde lo suficiente como para que el proxy corte la conexión, y corrige la semántica del mensaje de corte, que hoy asume "rechazo de transporte = 0 aplicado" — falso.

## Problema (bug real de prod, reportado por el usuario en el primer uso)

Bulk de ~200+ servicios: el FE mostró **"Se cortó en el lote 1/2. Se aplicaron 0 servicios antes del corte — el resto de los lotes NO se envió"**, pero el lote 1 **SÍ se aplicó ENTERO** en el servidor (verificado en el RADIUS).

**Causa raíz confirmada:** un lote de 200 ítems seriales con throttle de 300ms en el BE tarda 2-4 minutos. El proxy corta la conexión HTTP en curso (~60s de idle/total, según la capa) → el `bulkMutation.mutateAsync` de ese lote RECHAZA por **fallo de transporte** mientras el BE sigue procesando en background y termina el lote completo. El mensaje de corte actual (`runPppoeBulkBatches` + `BulkChangePlanModal`) trata TODO rechazo de lote como "0 aplicados", sin distinguir un fallo de transporte (estado del BE desconocido, puede haber terminado igual) de un fallo real de aplicación (400/401/422 síncrono, antes de procesar).

## Decisiones (usuario, ronda de fix — no re-decidir)

1. **Tamaño de lote 200 → 25.** Constante nueva `BULK_BATCH_SIZE = 25` en `src/utils/pppoeBulkBatches.ts`, separada del cap de selección/confirmación `BULK_SELECTION_CAP = 200` (`PppoeManagementTab.tsx`, **sin cambios** — sigue gateando el checkbox de confirmación de N>200 y sigue alineado al guard del BE `MAX_BULK_IDS=200`, que tampoco cambia). ~10-30s por lote de 25 sobrevive cualquier timeout de proxy razonable. El camino "directo" (un solo request, sin orquestador) pasa a aplicarse **solo** cuando `ids.length <= BULK_BATCH_SIZE`; todo lo demás — incluido el rango 26-200 que hoy va directo — se particiona en lotes de 25. La toolbar informa "se enviará en X lotes de 25" (antes: lotes de 200, y solo para N>200).
2. **Semántica de corte honesta.** Cuando un lote rechaza por transporte, el resultado del corte deja de decir "0 aplicados" y expone los ids de ESE lote como `unconfirmed` (estado desconocido — pueden haberse aplicado igual), sin tocar la clasificación `ok`/`failed` existente (que sigue siendo best-effort dentro de un lote resuelto). Los lotes posteriores nunca enviados quedan implícitamente sin confirmar también (no entran en `ok`/`failed`/`unconfirmed`, pero tampoco se limpian de la selección — ya distinguibles hoy). El modal cambia el copy: ya no afirma "se aplicaron N", dice que el lote no obtuvo respuesta, que sus cambios PUEDEN haberse aplicado, invita a verificar la lista y reintentar (reaplicar el mismo plan es idempotente/inofensivo). Los conteos del resumen usan "confirmados", no "aplicados".
3. **Selección post-corte sin cambios de comportamiento:** los ids `unconfirmed` + los no-enviados quedan seleccionados; los `ok` confirmados se limpian — igual que hoy (`applyOkToSelection` ya solo remueve `ok`).
4. La invalidación de la lista al terminar/cortar la corrida se mantiene igual (una sola vez, ya sea corrida completa o cortada).

## Scope

- **FE únicamente**, worktree `bulk-batch-fix-fe` (`ipnext-frontend`):
  - `src/utils/pppoeBulkBatches.ts` — constante `BULK_BATCH_SIZE`, campo `unconfirmed` en `RunPppoeBulkBatchesResult`, default de `batchSize`.
  - `src/pages/networking/PppoeManagementTab.tsx` — umbral directo-vs-lotes, mensaje de la toolbar, copy honesto del corte en `BulkChangePlanModal`.
  - Tests: `src/__tests__/utils/pppoeBulkBatches.test.ts`, `src/__tests__/networking/PppoeManagementTab.bulk.test.tsx` (reescritura honesta de los casos que asumían lotes de 200 o el mensaje viejo de corte).
- **Fuera de scope:** BE (el endpoint `POST /pppoe/bulk/change-plan` y su guard `MAX_BULK_IDS=200` NO cambian), `MoveNasModal`, `GestionRedPage`, infraestructura de proxy/timeouts (se ataca el síntoma acortando el lote, no la causa de infraestructura).

## Riesgo / Rollback

Riesgo bajo — cambia una constante de chunking, un campo agregado (aditivo) al resultado del orquestador FE, y copy de un modal. `git revert` limpio: sin contrato BE tocado, sin migración, sin cambio de rutas ni de hooks de red.

## Success Criteria

- [ ] `chunkIds` con tamaño 25: 26 ids → 2 lotes (25+1); 25 ids → 1 lote.
- [ ] Selecciones de 26-200 (antes: camino directo de 1 request) ahora se particionan en lotes de 25.
- [ ] Un lote rechazado por transporte expone sus ids en `unconfirmed` en el resultado de `runPppoeBulkBatches`.
- [ ] El mensaje de corte del modal NO dice "se aplicaron 0"/"aplicados" para el lote cortado — dice que no hubo respuesta, que pueden haberse aplicado, y usa "confirmados" en los conteos.
- [ ] Selección post-corte = `unconfirmed` + no-enviados (los `ok` confirmados se limpian, sin cambios de comportamiento).
- [ ] Toolbar informa "se enviará en X lotes de 25".
- [ ] Tests existentes que asumían lotes de 200 o el mensaje viejo, reescritos honestamente (no debilitados).
- [ ] `TZ=UTC npx vitest run src/__tests__/networking/ src/__tests__/utils/ --silent` verde + `tsc --noEmit` limpio.

## Ola 2 (pedido del usuario 2026-07-02): async real + cancelación de verdad

### Intent

Pedido textual del usuario, sobre el fix de ola 1 ya en limpio: **"esto hazlo async, y que se pueda cortar todos"**. Esto INVIERTE la decisión de W2 (ola 1): "Cancelar" disabled durante TODA la corrida en lotes deja de existir — el operador necesita (1) poder cortar la corrida DE VERDAD entre lotes, y (2) poder seguir trabajando mientras la corrida sigue en segundo plano (el modal ya no debe bloquear).

### Decisiones (worktree `bulk-batch-fix-fe`, sub-agente FE — no re-decidir)

1. **Cortar real.** `runPppoeBulkBatches` gana `shouldCancel?: () => boolean`, chequeada ANTES de mandar cada lote (incluido el primero). Si devuelve `true`, no se manda ningún lote más. Nuevo campo aditivo `cancelled: { atBatch, totalBatches } | null` en el resultado — DISTINTO de `cut`/`unconfirmed` (rechazo de TRANSPORTE de un lote YA enviado): la cancelación nunca deja nada "en vuelo sin resolver", el chequeo es previo al envío. Ambos campos PUEDEN convivir: si el operador corta mientras el lote en vuelo termina rechazando por transporte de todos modos, el resultado lleva `cut`+`unconfirmed` Y `cancelled` sobre el mismo lote — el mensaje prioriza el de `cut` (más grave, estado desconocido) y suma la nota de corte manual.
2. **Camino en lotes vs. camino directo.** Para una corrida en lotes (selección > `BULK_BATCH_SIZE`), el botón "Cancelar" (disabled durante todo el envío, decisión de ola 1/W2) es REEMPLAZADO por "Continuar en segundo plano" (SIEMPRE habilitado, cierra el modal SIN abortar la corrida) + "Cortar" (real, siempre visible/habilitado hasta que se clickea, pasa a "Cortando… (termina el lote en vuelo)" deshabilitado). El camino directo (`<=BULK_BATCH_SIZE`, un solo request corto) queda INTACTO: "Cancelar" sigue disabled durante el envío, sin "Cortar" ni "Continuar en segundo plano" — no hay nada que cortar a mitad de camino ni segundo plano que valga la pena para un solo request.
3. **Segundo plano.** "Continuar en segundo plano" solo cierra el modal — todo el estado de la corrida (progreso, corte, resultado) vive en el componente del tab, no en el modal, así que la corrida sigue sin cambios. Mientras corre con el modal cerrado, un chip persistente arriba de la tabla muestra "Cambiando plan: lote N/X" (texto con `aria-live="polite"`) + el mismo botón "Cortar". Al terminar (completa, cortada o cancelada) con el modal cerrado, un banner muestra el resumen compacto (X confirmados ok, Y fallidos, Z sin confirmación/no enviados) con "Ver detalle" (reabre el modal en la vista de resultado, ya poblada) y "Descartar" (limpia todo el estado de la corrida).
4. **No se puede abrir un segundo bulk en simultáneo.** Mientras hay una corrida en curso (incluso en segundo plano, con el modal cerrado), el botón "Cambiar plan" de la toolbar de selección queda deshabilitado con un `title` explicativo.
5. **Límite conocido, documentado (no resuelto en esta ola):** si el operador navega FUERA del tab de PPPoE durante la corrida, las mutaciones ya disparadas completan igual (no se abortan), pero el resumen/progreso se pierde — el estado vive en el componente del tab y no sobrevive a su desmontaje. Recuperarlo queda fuera de alcance.

### Scope ola 2

- Mismos archivos que ola 1 (worktree `bulk-batch-fix-fe`, `ipnext-frontend`): `src/utils/pppoeBulkBatches.ts`, `src/pages/networking/PppoeManagementTab.tsx` (+ su CSS module), `src/__tests__/utils/pppoeBulkBatches.test.ts`, `src/__tests__/networking/PppoeManagementTab.bulk.test.tsx`.
- Reescritura honesta del test W2 viejo de ola 1 ("Cancelar disabled durante TODA la corrida") — ese comportamiento ya no existe para el camino en lotes.
- **Fuera de scope:** igual que ola 1 (BE, `MoveNasModal`, `GestionRedPage`, infraestructura de proxy/timeouts) + recuperar el resumen tras navegar fuera del tab (límite conocido, documentado, no resuelto).

### Success Criteria ola 2

- [x] `shouldCancel` chequeada ANTES de mandar cada lote (incluido el primero); 4 lotes, cancela tras el 2° → 2 enviados, `cancelled.atBatch=3`.
- [x] `cancelled` es un campo NUEVO (aditivo) en el resultado de `runPppoeBulkBatches`, distinto de `cut`/`unconfirmed`; ambos pueden convivir (cancel+cut sobre el mismo lote).
- [x] Camino en lotes: "Cortar" real (siempre visible/habilitado) + "Continuar en segundo plano" (habilitado) reemplazan a "Cancelar". Camino directo (`<=BULK_BATCH_SIZE`) intacto: "Cancelar" sigue disabled durante el envío, sin botones nuevos.
- [x] Chip de progreso persistente (con `aria-live="polite"`) + banner de resumen post-corrida en background, con "Ver detalle" (reabre el modal con el resultado) y "Descartar".
- [x] "Cambiar plan" de la toolbar deshabilitado (con `title`) mientras hay una corrida en curso.
- [x] Selección post-cancelación retiene lo no confirmado/no enviado — mismo invariante que el corte por transporte (ola 1).
- [x] Tests del W2 viejo reescritos honestamente (no debilitados) + cobertura nueva de cancelación/segundo plano/accesibilidad.
- [x] `TZ=UTC npx vitest run src/__tests__/networking/ src/__tests__/utils/ --silent` verde (510/510) + `tsc --noEmit` (`NODE_OPTIONS=--max-old-space-size=6144`) limpio.
