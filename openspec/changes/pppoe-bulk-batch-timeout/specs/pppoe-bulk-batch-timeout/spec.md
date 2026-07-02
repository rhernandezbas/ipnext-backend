# Capability: pppoe-bulk-batch-timeout

Fix de timeout + mensaje de corte falso en el envío en lotes del cambio de plan masivo de PPPoE (`pppoe-bulk-select-filter`). Reduce el tamaño de lote de 200 a 25 y corrige la semántica del corte: un rechazo de transporte deja de asumir "0 aplicados".

**Ola 2 (pedido del usuario 2026-07-02):** "esto hazlo async, y que se pueda cortar todos" — agrega cancelación real del operador entre lotes e invierte la decisión de W2 (ola 1): la corrida en lotes deja de bloquear al operador (puede seguir trabajando con la corrida en segundo plano).

## MODIFIED Requirements

### Requirement: Envío en lotes de 25 secuenciales con agregación

Para una selección de más de `BULK_BATCH_SIZE` (25) ids, el FE SHALL particionar la selección en lotes de ≤25 y enviarlos SECUENCIALMENTE reutilizando `POST /api/pppoe/bulk/change-plan` (guard BE de 200 ids por request sin modificar — 25 nunca lo alcanza). El camino de un solo request directo (sin orquestador) SHALL aplicarse ÚNICAMENTE cuando la selección tiene `<= BULK_BATCH_SIZE` ids; una selección de, por ejemplo, 150 ids (antes enviada como un único request) SHALL particionarse en 6 lotes de 25.

#### Scenario: 60 seleccionados → 3 lotes de 25/25/10
- **GIVEN** una selección de 60 ids y un plan válido
- **WHEN** el operador confirma el bulk
- **THEN** el FE hace 3 requests secuenciales a `POST /api/pppoe/bulk/change-plan`: 25, 25 y 10 ids
- **AND** muestra el progreso "lote 1/3", "lote 2/3", "lote 3/3 — 60 servicios"

#### Scenario: selección de 150 ids ya NO va directa — se particiona en lotes de 25
- **GIVEN** una selección de 150 ids (antes de este fix: un único request directo)
- **WHEN** el operador confirma el bulk
- **THEN** el FE hace 6 requests secuenciales de 25 ids cada uno (NO un único request de 150)

#### Scenario: N≤25 flujo directo intacto
- **GIVEN** una selección de 25 ids o menos
- **WHEN** el operador confirma el bulk
- **THEN** el FE hace UN solo request directo con esos ids, sin pasar por el orquestador de lotes

### Requirement: Aviso de lotes con el tamaño nuevo

El toolbar de selección SHALL informar, para más de `BULK_BATCH_SIZE` (25) seleccionados, "N seleccionados — se enviará en X lotes de 25" (con `X = ceil(N/25)`), sin bloquear el botón. El checkbox obligatorio de confirmación ("Entiendo que voy a cambiar el plan de N servicios") SHALL seguir gateado por `BULK_SELECTION_CAP` (>200), SIN CAMBIOS — es independiente del tamaño de lote.

#### Scenario: aviso de lotes de 25 sin checkbox extra (150, entre 25 y 200)
- **GIVEN** una selección de 150 ids
- **WHEN** se renderiza el toolbar y se abre el modal
- **THEN** el toolbar muestra "150 seleccionados — se enviará en 6 lotes de 25"
- **AND** el modal NO exige el checkbox de confirmación (150 no supera `BULK_SELECTION_CAP=200`)

#### Scenario: aviso de lotes + checkbox combinados (>200)
- **GIVEN** una selección de 340 ids
- **WHEN** se renderiza el toolbar y se abre el modal
- **THEN** el toolbar muestra "340 seleccionados — se enviará en 14 lotes de 25"
- **AND** el modal exige el checkbox "Entiendo que voy a cambiar el plan de 340 servicios" para habilitar el confirm (sin cambios respecto al comportamiento de `BULK_SELECTION_CAP`)

### Requirement: Corte por fallo de lote entero — semántica honesta

Si un lote entero RECHAZA por fallo de transporte (red caída, timeout de proxy — NO un 4xx/422 síncrono de validación), el FE SHALL exponer los ids de ESE lote como `unconfirmed` en el resultado de `runPppoeBulkBatches`, y SHALL cortar el envío de los lotes restantes. El sistema NO SHALL afirmar que los servicios del lote cortado "no se aplicaron" — su estado en el servidor es DESCONOCIDO (el rechazo es de transporte, no de aplicación; el BE puede haber completado el procesamiento en background). Los ítems `failed` individuales (best-effort dentro de un lote que SÍ resuelve) siguen sin cortar el envío — sin cambios.

#### Scenario: rechazo de lote entero expone `unconfirmed` y corta
- **GIVEN** una selección de 75 ids (3 lotes de 25) donde el 2º lote RECHAZA por transporte
- **WHEN** se ejecuta el bulk
- **THEN** `runPppoeBulkBatches` devuelve `cut = { cutAtBatch: 2, totalBatches: 3 }` y `unconfirmed` = los 25 ids del lote 2
- **AND** el lote 3 NUNCA se envía
- **AND** el agregado `ok`/`failed` conserva lo que ya reportó el lote 1

#### Scenario: el modal ya NO dice "se aplicaron 0" ni "aplicados" para el lote cortado
- **GIVEN** el escenario anterior (corte en el lote 2/3)
- **WHEN** se renderiza el resumen del modal
- **THEN** el mensaje de corte indica que el lote 2/3 no obtuvo respuesta del servidor, que sus cambios PUEDEN haberse aplicado igual, y usa "confirmados" (no "aplicados") para los conteos de `ok`/`failed` acumulados hasta el corte
- **AND** invita a verificar la lista y reintentar, aclarando que reaplicar el mismo plan es inofensivo
- **AND** el texto NO contiene la afirmación "se aplicaron 0 servicios"

#### Scenario: ítems failed individuales siguen sin cortar (sin cambios)
- **GIVEN** una selección de 50 ids (2 lotes de 25) donde el lote 1 resuelve `200` con algunos ítems en `failed`
- **WHEN** se ejecuta el bulk
- **THEN** el lote 2 SÍ se envía y el agregado final incluye ambos lotes, sin mensaje de corte

## ADDED Requirements

### Requirement: Selección post-corte incluye lo no confirmado

Tras una corrida cortada, la selección en el FE SHALL retener los ids `unconfirmed` (del lote rechazado) y los ids de los lotes nunca enviados (post-corte); SHALL remover únicamente los ids que llegaron a `ok` en algún lote resuelto. Este comportamiento es el mismo invariante que ya aplica al camino N≤`BULK_BATCH_SIZE` (solo se limpian los `ok` confirmados).

#### Scenario: selección tras un corte
- **GIVEN** una selección de 100 ids (4 lotes de 25) donde el lote 1 resuelve con 20 `ok` + 5 `failed`, y el lote 2 RECHAZA por transporte
- **WHEN** termina la corrida (cortada)
- **THEN** la selección final tiene 80 ids: los 5 `failed` del lote 1 + los 25 `unconfirmed` del lote 2 + los 50 del lote 3 y 4 (nunca enviados)
- **AND** los 20 `ok` del lote 1 ya NO están seleccionados

---

## Ola 2 (pedido del usuario 2026-07-02, textual: "esto hazlo async, y que se pueda cortar todos")

Invierte la decisión de W2 (ola 1): la corrida en lotes deja de bloquear al operador. Agrega cancelación real entre lotes y ejecución en segundo plano — el modal deja de ser la única forma de ver/controlar la corrida.

### ADDED Requirement: Cancelación real entre lotes

Para una corrida en lotes (selección `> BULK_BATCH_SIZE`) en curso, el operador SHALL poder cortarla de verdad mediante un botón "Cortar" — real, siempre visible y habilitado durante la corrida (tanto en el modal como en el chip de segundo plano), hasta que se clickea (pasa a "Cortando… (termina el lote en vuelo)", deshabilitado). El sistema SHALL chequear la cancelación ANTES de mandar cada lote (incluido el primero) — un lote YA en vuelo NUNCA se aborta; sus `ok`/`failed` se agregan igual cuando resuelve. El resultado de `runPppoeBulkBatches` SHALL exponer `cancelled: { atBatch, totalBatches } | null` (campo aditivo), DISTINTO de `cut`/`unconfirmed` (rechazo de TRANSPORTE de un lote ya enviado) — la cancelación nunca deja nada "en vuelo sin resolver": el chequeo es previo al envío, así que el último lote enviado siempre llegó a resolver (`ok`/`failed` reales) o nunca se mandó. Ambos campos (`cut` y `cancelled`) SHALL poder convivir cuando el lote en vuelo termina rechazando por transporte mientras el operador ya había pedido cortar — sobre el MISMO lote.

#### Scenario: Cortar detiene la corrida antes del próximo lote
- **GIVEN** una selección de 100 ids (4 lotes de 25) con el lote 1 en vuelo
- **WHEN** el operador clickea "Cortar" y el lote 1 resuelve OK (25 confirmados)
- **THEN** el lote 2 NUNCA se manda
- **AND** el resultado tiene `cancelled = { atBatch: 2, totalBatches: 4 }` y `cut = null`
- **AND** el resumen dice "Corrida cortada en el lote 2 de 4. Confirmados: 25 ok, 0 fallidos."
- **AND** la selección retiene los 75 ids no confirmados/no enviados (lotes 2, 3 y 4) — solo los 25 `ok` del lote 1 se limpian

#### Scenario: cancel + cut combinados priorizan el mensaje de `cut`
- **GIVEN** el lote 2 (de 3) está en vuelo y el operador clickea "Cortar" antes de que resuelva
- **WHEN** el lote 2 rechaza por transporte de todos modos
- **THEN** el resultado tiene `cut = { cutAtBatch: 2, totalBatches: 3 }`, `unconfirmed` = los ids del lote 2 Y `cancelled = { atBatch: 2, totalBatches: 3 }`
- **AND** el mensaje del modal muestra primero el texto de `cut` ("no obtuvo respuesta del servidor", estado desconocido — más grave) y suma la nota "Además, cortaste la corrida manualmente…"
- **AND** el mensaje de cancelación PURA (el que se usa cuando no hay `cut`) NO aparece en este caso

### ADDED Requirement: Segundo plano — la corrida no bloquea al operador

Durante una corrida en lotes, el botón que antes decía "Cancelar" (disabled durante todo el envío — decisión de ola 1/W2, ahora revertida para este camino) SHALL ser reemplazado por "Continuar en segundo plano" (SIEMPRE habilitado) — cierra el modal SIN abortar la corrida; todo el estado de progreso (lote actual, corte, resultado) vive en el componente del tab, no en el modal, así que la corrida sigue sin cambios de comportamiento. Mientras la corrida sigue con el modal cerrado, un chip persistente arriba de la tabla SHALL mostrar el progreso ("Cambiando plan: lote N/X") con el texto marcado `aria-live="polite"`, y el mismo botón "Cortar" real. Al terminar la corrida (completa, cortada o cancelada) con el modal cerrado, un banner SHALL mostrar el resumen compacto (X confirmados ok, Y fallidos, Z sin confirmación/no enviados) con los botones "Ver detalle" (reabre el modal en la vista de resultado, ya poblada — no vuelve a ejecutar nada) y "Descartar" (limpia todo el estado de la corrida). Mientras hay una corrida en curso (incluso en segundo plano), el botón "Cambiar plan" de la toolbar de selección SHALL quedar deshabilitado con un `title` explicativo — no se puede abrir un segundo bulk en simultáneo. El camino directo (`<= BULK_BATCH_SIZE`, un solo request corto) queda INTACTO: sin chip, sin "Continuar en segundo plano" — "Cancelar" sigue disabled durante el envío (comportamiento de ola 1, sin cambios — un solo request corto no necesita nada de esto).

#### Scenario: La seleccion queda CONGELADA durante la corrida (fix post-re-review 2026-07-02)
- **GIVEN** una corrida en lotes en curso (modal abierto o en segundo plano)
- **WHEN** el operador intenta tocar la seleccion (checkbox de fila, header "seleccionar pagina", "Limpiar" o "Seleccionar los N del filtro")
- **THEN** esos controles estan `disabled` con title "Hay un cambio de plan en curso"; la seleccion NO cambia; el chip de progreso con "Cortar" sigue visible (su condicion NO depende de la seleccion); se rehabilitan al terminar la corrida

#### Scenario: Continuar en segundo plano
- **GIVEN** una corrida en lotes en curso, con el modal abierto
- **WHEN** el operador clickea "Continuar en segundo plano"
- **THEN** el modal se cierra
- **AND** aparece el chip con el progreso del lote en curso ("Cambiando plan: lote N/X")
- **AND** la corrida sigue mandando los lotes restantes sin interrupción

#### Scenario: banner de resumen al terminar en segundo plano
- **GIVEN** la corrida terminó (completa, cortada o cancelada) con el modal cerrado
- **WHEN** se renderiza el tab
- **THEN** aparece un banner con el resumen compacto y los botones "Ver detalle" y "Descartar"
- **AND** "Ver detalle" reabre el modal mostrando el mismo resultado (`result !== null`, sin re-ejecutar la corrida)
- **AND** "Descartar" limpia el resumen — el banner deja de aparecer

#### Scenario: no se puede abrir un segundo bulk mientras hay uno en curso
- **GIVEN** una corrida (en el modal o en segundo plano) en curso
- **WHEN** se renderiza la toolbar de selección
- **THEN** el botón "Cambiar plan" está deshabilitado con un `title` explicativo
- **AND** se rehabilita apenas la corrida termina

#### Scenario: camino directo intacto (sin chip, sin segundo plano)
- **GIVEN** una selección de `<= BULK_BATCH_SIZE` ids (un solo request directo)
- **WHEN** el operador confirma el bulk
- **THEN** "Cancelar" sigue disabled durante el envío, con el mismo comportamiento de ola 1
- **AND** NO aparecen "Cortar" ni "Continuar en segundo plano" en el modal
- **AND** no aparece ningún chip (no hay `batchProgress` — este camino no pasa por el orquestador de lotes)

### ADDED Requirement: Límite conocido — el resumen no sobrevive a la navegación fuera del tab

Si el operador navega FUERA del tab de PPPoE mientras una corrida sigue en segundo plano, las mutaciones ya disparadas SHALL completar igual (no se abortan — no hay forma de cancelar un request HTTP ya en curso desde este cambio). El resumen de progreso/resultado SHALL perderse al desmontarse el componente — el estado vive únicamente en el componente del tab, no en un store externo ni persistido. Este comportamiento queda documentado como límite conocido; recuperarlo (por ejemplo, persistiendo el estado de la corrida fuera del ciclo de vida del componente) queda FUERA de alcance de este cambio.

#### Scenario: navegar fuera del tab durante una corrida en segundo plano
- **GIVEN** una corrida en lotes en curso, en segundo plano (modal cerrado)
- **WHEN** el operador navega a otra sección de la app (se desmonta `PppoeManagementTab`)
- **THEN** los lotes ya disparados siguen resolviendo y aplicándose en el servidor (no hay forma de abortarlos desde el FE)
- **AND** el chip/banner de progreso y resumen se pierden — no hay forma de recuperarlos sin volver a listar los servicios y verificar manualmente
