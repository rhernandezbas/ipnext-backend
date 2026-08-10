# Tasks — `gr-receipt-annulment`

TDD estricto en todo: RED (referenciando el scenario de spec) → GREEN → REFACTOR. Runner `npm test`
(Jest). Use cases SIEMPRE con adapters in-memory — jamás mockear Prisma (excepción ya establecida: los
tests de `where` de los adapters Prisma espían `prisma.<tabla>.findMany`, molde
`PrismaPortalPaymentsReader.test.ts`).

## Fase 1 — Migración + config + normalizador de knobs

- [x] 1.1 Migración `prisma migrate diff` → `20261109000000_finance_receipt_reconcile_lane` (posterior a
      `20261108000000_wifi_guest_intent`, la última existente): 5 columnas aditivas en
      `FinanceReceiptSyncConfig` (`reconcileEnabled` bool default `true`, `reconcileWindowDays` int
      default `35`, `reconcileCheckIntervalMs` int default `21600000`, `annulmentGuardMaxPct` int
      default `5`, `annulmentGuardMinCount` int default `5`). Molde:
      `20261023000300_finance_delta_starvation_threshold`. Jamás SQL a mano.
- [x] 1.2 Actualizar `FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS` con los mismos 5 valores.
- [x] 1.3 RED `syncConfigNormalizer.test.ts` (nuevo) — tabla completa Decisión 7, corrida contra AMBOS
      adapters (Prisma + in-memory).
- [x] 1.4 RED caso extremo bajo: `reconcileWindowDays=0` ⇒ cae a `35` (default), NUNCA clampea a `1`.
- [x] 1.5 RED caso extremo alto: `annulmentGuardMaxPct=100` ⇒ cae a `5` (default), `100` NUNCA se acepta
      (sería "nunca abortar").
- [x] 1.6 GREEN `normalizeFinanceReceiptSyncConfig` puro en
      `domain/ports/FinanceReceiptSyncConfigRepository.ts`, llamado desde `get()` en Prisma e in-memory.
- [x] 1.7 RED/GREEN caso `reconcileWindowDays` por debajo del piso de la invariante ventana-vs-rebuild
      (p.ej. `20`, dentro de `[1,90]` pero por debajo del peor caso de 35 días del rebuild mensual) — la
      escritura se rechaza / cae al mínimo válido `35` (scenario 15, `finance-growth`). **Nota de
      diseño**: la tabla de Decisión 7 declara el rango `[1, 90]`, que por sí solo NO alcanza para este
      invariante — acá se interpreta el mínimo efectivo como `35`. Dejar constancia en el test de que
      `sdd-verify` debe confirmar esta lectura contra el design.
- [x] 1.8 RED `existingIds(grReceiptIds: string[]): Promise<Set<string>>` — método obligatorio nuevo en
      el port `FinancePaymentReceiptRepository`; sin implementarlo en algún adapter, no compila.
- [x] 1.9 GREEN `existingIds` en Prisma (`findMany({ where: { grReceiptId: { in } }, select:
      { grReceiptId: true } })`) y en in-memory (`Set` sobre las filas existentes).

## Fase 2 — Parser deja de saltear + `isRealAnnulment` endurecido

- [x] 2.1 RED reescribir `financeDates.test.ts:86` (hoy ISO → `false`) a ISO → `true`, con comentario
      explicando que pineaba el bug fail-open (scenario 17). **Desvío anotado**: `specs/finance-growth/
      spec.md`'s scenario 17 dice literalmente `THEN devuelve false` — contradice su propia nota
      "(Previously: ... devolvía false)" (leído literal, el scenario no cambia nada) Y el Decision 5
      de design.md (`Nuevo: true`, fila marcada ⚠️ como "cuenta plata anulada como cobrada en
      silencio"). Implementado per design.md (true = anulado real). sdd-verify debe corregir el texto
      del spec.
- [x] 2.2 RED completar `financeDates.test.ts` con la tabla entrada→salida de la Decisión 5: centinela
      todo-ceros en cualquier ancho/orden (scenario 18), DD-MM-AAAA válida, ISO válida, fechas
      imposibles `32-13-2026`/`2026-13-45` ⇒ `true`+warn, residuo basura (`'nota de credito'`, `'N/A'`)
      ⇒ `true`+warn (scenarios 17, 18, 19 parcial — ver Fase 4.10/3.1 para el residuo a nivel de página).
- [x] 2.3 GREEN `financeDates.ts` — aceptar ISO (desambiguación: primer componente de 4 dígitos ⇒ ISO,
      si no DD-MM-AAAA), residuo no vacío/no-centinela/no-parseable ⇒ `true`+warn, mensaje del warn
      actualizado ("tratado como ANULADO").
- [x] 2.4 RED reescribir `mapGrReceipt.test.ts:28` (hoy `toBe(false)` incondicional) a: `anulado` se
      deriva de `isRealAnnulment(r.fechaAnulacion, r.grReceiptId)`, con comentario explicando el porqué
      de la reescritura.
- [x] 2.5 GREEN `mapGrReceipt.ts:33` — `anulado: isRealAnnulment(r.fechaAnulacion, r.grReceiptId)`.
- [x] 2.6 RED reescribir `GestionRealClient.receipts.test.ts:101-112` (hoy "excludes...") a "**incluye**
      el recibo anulado, lleva `fechaAnulacion` cruda, y sus `aplicaciones`/`items`/`retenciones` siguen
      viniendo" — con comentario explicando el porqué (scenario 1). También se actualizó el test vecino
      ("centinela exacto") que asumía `fechaAnulacion: null` hardcodeado — ahora espera el string crudo
      del centinela.
- [x] 2.7 GREEN `GestionRealClient.ts:811` — sacar `if (isRealAnnulment(...)) continue;`; línea `:825`
      `fechaAnulacion: null` → `fechaAnulacion: str(raw.fecha_anulacion)`. El sobre de error (`:784-788`)
      y los guards F1/F2/F11/F12 NO se tocan. Bonus DIP: el import de `isRealAnnulment` (application/) en
      este adapter de infrastructure/ quedó sin uso y se sacó — el parser ya no decide sobre el dominio.
- [x] 2.8 Actualizar docblocks que mienten: `mapGrReceipt.ts:18-24`, `FinancePaymentReceiptRepository.ts:
      12-16` ("Always false in practice"), `schema.prisma:2662-2663`, comentarios
      `"post-annulment-exclusion"` en `DeltaPageResult`/`BackfillPageResult`.

## Fase 3 — Guard sistémico con clase de error propia

- [x] 3.1 RED `financeAnnulmentGuard.test.ts` (nuevo) — frontera: `0/100` no dispara, `5/100` no
      (`>` estricto), `6/100` sí, `3/4` (75%) no (piso `minCount=5`), `total=0` no dispara (scenarios
      20, 21).
- [x] 3.2 GREEN `financeAnnulmentGuard.ts` (application, pura, sin I/O) — fórmula exacta de Decisión 4.
- [x] 3.3 RED `FinanceReceiptAnnulmentGuardError` NO debe ser leído por `trackGrHealth` como fallo de
      GR: lanzar la excepción y verificar que `grConsecutiveFailures`/`effectiveIntervalMs` NO escalan.
- [x] 3.4 GREEN clase base `FinanceReceiptPostFetchError` (abstract); `FinanceReceiptPersistenceError` y
      `FinanceReceiptAnnulmentGuardError` la extienden; `trackGrHealth` chequea
      `instanceof FinanceReceiptPostFetchError`. Confirmar que `instanceof FinanceReceiptPersistenceError`
      sigue siendo `true` en todo el código existente (cero regresión).
- [x] 3.5 Extraer `mapAndGuardReceiptPage`/`persistReceiptPage` a `financeReceiptPageIngest.ts`
      (application) — Decisión 8. Gate inmediato: correr `SyncGrReceiptsDelta.test.ts`,
      `SyncGrReceiptsBackfillBatch.test.ts`, `finance-receipts-ingest-seam.test.ts` SIN modificarlos —
      deben seguir en verde. Si hace falta tocar alguno, PARAR: el refactor cambió comportamiento.
      **GATE PASADO** (44 tests, sin tocar los 3 archivos). **Desvío anotado**: el carril delta NO
      recibió un `syncConfig` inyectado (hubiera roto la firma del constructor y el gate de arriba) —
      el guard corre igual sobre delta pero con los thresholds DEFAULT hardcodeados
      (`FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS`), no live-reloadable. Backfill y reconcile sí usan la
      config viva. Es una lectura deliberada de la celda "Los tres" de la Decisión 4 — sdd-verify debe
      confirmarla o pedir que se abra la config al delta con un change aparte.

## Fase 4 — Carril `reconcile`: `SyncState`, cursor, use case, seam

- [x] 4.1 Mover `parseCompositeCursor`/`deltaCursorHasPendingPages` a `financeReceiptCursors.ts`
      (application); `SyncGrReceiptsDelta` re-exporta `deltaCursorHasPendingPages`. Gate: tests de delta
      existentes siguen en verde sin tocarlos. **GATE PASADO** (97 tests, sin tocar delta/backfill/seam/
      scheduler/GetFinanceSyncStatus).
- [x] 4.2 RED `SyncGrReceiptsReconcileWindow.test.ts` (U6) — primer barrido calcula ventana; paginado;
      ventana CONGELADA cuando el reloj cruza medianoche AR a mitad de barrido; cierre a `cursor: null`;
      cadencia (`isReconcileDue`); cursor corrupto ⇒ recalcula ventana desde cero; `reconcileEnabled:
      false` ⇒ cero llamadas a GR.
- [x] 4.3 GREEN `SyncGrReceiptsReconcileWindow.ts` (application) — cursor compuesto
      `"{fechaDesde}:{fechaHasta}:{offset}"`, ventana congelada al arrancar el barrido, `isReconcileDue`,
      llama `mapAndGuardReceiptPage`/`persistReceiptPage`, logea con `existingIds` (nuevos/anulados/
      `masViejoReparado`) y `WARN` de borde. `itemRepo`/`retencionRepo` obligatorios y no-trailing, throw
      en el constructor si faltan (criterio R9).
- [x] 4.4 RED seam S4 — recibo con `fecha_recibo` de hace 5 días, ausente del espejo (confirmación
      tardía) ⇒ tras un barrido del reconcile, está (scenario 13, el bug medido).
- [x] 4.5 RED seam S1 — payload con `fecha_anulacion` real ⇒ recibo **presente** (`rows.size === 1`) Y
      `anulado === true`, hijas persistidas (scenario 1).
- [x] 4.6 RED seam S2 (el flip, LA invariante del change) — barrido 1 persiste recibo sano
      (`anulado:false`); barrido 2 mismo `grReceiptId` con `fecha_anulacion` real ⇒ la MISMA fila pasa a
      `anulado:true`, ejercitando el bloque `update` del upsert (soporta también scenario 27 del portal).
- [x] 4.7 RED seam S3 — re-upsert sano de una fila sana ⇒ sigue `false` (no hay flip espurio).
- [x] 4.8 RED seam — re-barrer el MISMO rango dos veces no duplica filas: conteo de
      `FinancePaymentReceipt`/`Item`/`Application`/`Retencion` por `grReceiptId` sigue en 1 tras el
      segundo barrido (scenario 14).
- [x] 4.9 RED seam — sobre de error de GR (`{"error":"N"}`, N≠"0") durante una página del reconcile ⇒
      `parseReceiptsResponse` tira, cero escrituras, cursor sin avanzar (scenario 16 — mismo
      comportamiento que delta/backfill hoy, sin dedicado en la tabla S1-S6 del design; se completa acá).
- [x] 4.10 RED seam S5 — página con 63/100 en residuo ⇒ `execute()` tira,
      `receiptRepo.rows.size === 0` (cero escrituras), cursor sin avanzar, `lastResult` arranca con
      `error:`. **Parcial**: la parte `scheduler.status.effectiveIntervalMs NO escala` (GR no culpado)
      requiere el scheduler con `syncReconcile` cableado — eso es Fase 5/6. Ya está PROBADO
      genéricamente en 3.3 (el clasificador `trackGrHealth` es agnóstico de carril: se probó lanzando
      `FinanceReceiptAnnulmentGuardError` desde el delta y confirmando que no escala) — se completa el
      caso con el carril reconcile real en Fase 5 (tarea 5.7/S6) una vez wireado.
- [x] 4.11 GREEN de 4.4 a 4.10 (si algo no quedó cubierto por 4.3). Los 12 tests del seam corrieron en
      verde en el primer intento (incluye los 5 preexistentes) — la implementación de 4.3 ya cubría todo
      el comportamiento que estos escenarios de integración ejercitan.

## Fase 5 — Arbitraje del scheduler: delta > reconcile > backfill

- [x] 5.1 RED "Delta claims the tick over reconcile and backfill" (scenario 6).
- [x] 5.2 RED "Reconcile claims the tick when delta is quiet and its own cadence is due" (scenario 7).
- [x] 5.3 RED "Backfill is not starved indefinitely — turns entre ventanas de reconcile" (scenario 8).
- [x] 5.4 GREEN modificar el arbitraje en `FinanceReceiptIngestScheduler.ts:311-338` — `runReconcile`
      espeja F4 con el MISMO knob (`deltaStarvationThreshold`) pero contador PROPIO
      (`reconcileConsecutiveFailures`, nunca compartido con el del delta). **Desvío**: el constructor
      ganó el parámetro `syncReconcile` (obligatorio, posicional, con throw si falsy) ACÁ en vez de en
      Fase 6 — necesario para que la arbitración compile; Fase 6 hereda el wiring del composition root
      + los pines de aridad ya con el parámetro existente.
- [x] 5.5 RED `worstConsecutiveFailures()` suma el contador nuevo al `Math.max`.
- [x] 5.6 GREEN `activeLane` gana `'reconcile'` en el union (`'delta' | 'reconcile' | 'backfill' |
      'idle'`); `FinanceReceiptIngestTickResult.lane` gana `'reconcile'`; campo opcional
      `reconcile?: ReconcilePageResult`.
- [x] 5.7 RED seam S6 — arbitraje con los TRES use cases reales + scheduler real sobre ~40 ticks: delta
      gana siempre que está due; reconcile toma turnos cuando el delta no; backfill sigue progresando
      (`itemsSynced > 0`); con el delta envenenado (`PoisonedApplicationRepoS6`) F4 se mantiene
      (scenario 12, extendido a 3 carriles). También cierra la parte pendiente de S5 (4.10): un
      `FinanceReceiptAnnulmentGuardError`/`FinanceReceiptPersistenceError` real desde el carril
      reconcile no escala `effectiveIntervalMs` (probado con el scheduler REAL, no solo el genérico).
- [x] 5.8 GREEN de 5.7. Gotcha real capturado: 3 tests nuevos usaban un timestamp fijo para `lastRunAt`
      pero dejaban `now` en el reloj real del sistema — exactamente la fragilidad "reloj vivo" ya
      documentada en memoria del repo. Corregido con `now` fijo consistente en los tres.
- [x] 5.9 RED `GetFinanceSyncStatus` gana bloque `reconcile` (`lastRunAt`, `lastResult`, `itemsSynced`,
      `sweepInProgress`, `windowFrom`, `windowTo`, `pageOffset`), misma convención que delta/backfill.
      También se propagó a `FinanceSyncStatusDto`/`toFinanceSyncStatusDto` (aditivo en `/sync/status`).
- [x] 5.10 GREEN de 5.9.

## Fase 6 — Wiring + pin del composition root

- [x] 6.1 `bootstrapFinanceReceiptsIngest.ts` — construir `SyncGrReceiptsReconcileWindow` con los MISMOS
      repos Prisma + `syncConfig`, pasarlo al scheduler. **Hecho en Fase 5** (acoplado a la arbitración).
- [x] 6.2 `FinanceReceiptIngestScheduler` constructor — nuevo parámetro `syncReconcile` POSICIONAL y
      OBLIGATORIO (nunca opcional-trailing) + throw en el constructor si es falsy. **Hecho en Fase 5**.
- [x] 6.3 RED test de aridad con `@ts-expect-error` — pinea que
      `new FinanceReceiptIngestScheduler(delta, backfill, state, lock, cfg)` (sin `syncReconcile`) da
      error de TIPOS. Si el `@ts-expect-error` queda sin usar, el test falla. **Verificado con
      contrafáctico**: se aflojó `syncReconcile` a opcional manualmente, `tsc` reportó
      `TS2578: Unused '@ts-expect-error' directive` (el pin es real, no decorativo), se revirtió.
- [x] 6.4 RED test runtime — el constructor tira si `syncReconcile` es falsy (caza el JS sin tipos).
- [x] 6.5 RED `finance-growth-composition-root.test.ts` — slice desde
      `new SyncGrReceiptsReconcileWindow(` hasta su `);` de cierre (NUNCA una ventana de N caracteres
      mágica) — verificar que aparecen `itemRepo`, `retencionRepo`, `syncConfig`; y que la llamada
      `new FinanceReceiptIngestScheduler(` menciona la variable `syncReconcile`.
- [x] 6.6 GREEN de 6.1 a 6.5; `app.ts`/`main.ts` sin cambios (ya propagan la instancia del scheduler,
      confirmado — no se tocaron).

## Fase 7 — Filtros del dashboard + gemelos in-memory

- [x] 7.1 RED D1 `PrismaFinanceReceiptItemRepository.listByMonth` — espía `prisma.financeReceiptItem.
      findMany`, exige `where.receipt.anulado === false` junto a `fechaRecibo` (scenario 22).
- [x] 7.2 RED D2 `.listByClientAndMonth` idem + `clientGrId` (scenario 23).
- [x] 7.3 RED D3 `PrismaFinanceReceiptApplicationRepository.listByMonth` (scenario 24).
- [x] 7.4 RED D4 `.listByClientAndMonth` idem + `clientGrId` (scenario 25).
- [x] 7.5 GREEN agregar `anulado: false` a los 4 `where` Prisma.
- [x] 7.6 RED gemelos in-memory (`InMemoryFinanceReceiptItemRepository`,
      `InMemoryFinanceReceiptApplicationRepository`) — mismos 4 casos, semántica IDÉNTICA al Prisma
      (scenario 26, evita el bug W2: el gemelo replicando el filtro equivocado).
- [x] 7.7 GREEN de 7.6 — agregar `&& !receipt.anulado` en el mismo `filter` que ya resuelve el padre.
- [x] 7.8 RED D5 `BuildFinanceMonthlySnapshot.test.ts` — fixture con AL MENOS 2 recibos (uno sano, uno
      anulado, montos DISTINTOS): el anulado con items NO entra en la caja cobrada del mes ni sus
      aplicaciones en `unclassifiedAmountArs` (scenario 24 a nivel agregado; fixture no-degenerado).
- [x] 7.9 GREEN/confirmar 7.8 — confirmado: pasó en VERDE en el primer intento, ya satisfecho por 7.5/7.7
      (el use case no necesitó cambios, solo lee el port).
- [x] 7.10 RED `ComputeCacAndPayback.test.ts` — recibo anulado aplicado a un contrato NO participa de la
      atribución de cobranza (scenario 25).
- [x] 7.11 GREEN/confirmar 7.10 — confirmado: pasó en VERDE en el primer intento, mismo motivo que 7.9.
- [x] 7.12 RED `PrismaPortalPaymentsReader.test.ts` — fixture con recibo `anulado: true` real y monto
      ≠ 0: exige PRESENCIA en el fixture antes de assertear su AUSENCIA del resultado (scenarios 27, 28);
      más un caso de recibo `anulado: false` que sigue apareciendo con la misma forma sin cambios
      (`date`/`amounts`/`method`/`appliedTo`, scenario 29 — el `WHERE` ya existe y NO se toca, esto es
      gate, no RED nuevo sobre código nuevo). **Nota**: el test PAY-1.5 preexistente solo chequeaba la
      FORMA del `where`, nunca probó que el filtro excluye de verdad — el mock nuevo aplica
      `where.anulado`/`where.clientGrId` como un Prisma real, cerrando ese hueco de cobertura.

## Fase 8 — Contrafáctico + revert-probes

- [x] 8.1 Contrafáctico: sobre una copia/branch del código PRE-fix de este change (antes de las Fases
      2-7), correr S1 (4.5), S2 (4.6), S5 (4.10) y D5 (7.8) — confirmar que los CUATRO FALLAN. Restaurar
      el working tree al estado post-fix. **Hecho** vía `git checkout ade93a38 -- src/domain
      src/application/use-cases src/application/dto src/infrastructure/adapters src/infrastructure/
      scheduling` (tests quedaron en HEAD) + borrado manual de los 4 archivos nuevos que no existen
      pre-fix (`git checkout` con pathspec de directorio NO borra archivos ausentes en el commit
      origen — hubo que `rm` a mano). Resultado: `finance-receipts-ingest-seam.test.ts` (S1/S2/S5) NI
      COMPILA contra pre-fix (`Cannot find module SyncGrReceiptsReconcileWindow` — la feature
      literalmente no existe sin el fix) y D5 falla EN COMPORTAMIENTO real: `revenueTotalArs` esperado
      `5000`, recibido `13000` (el recibo anulado de $8000 se contaba igual). Restaurado con
      `git checkout HEAD -- <mismos paths>` + tsc limpio confirmado.
- [x] 8.2 Revert-probe: restaurar el `continue` del parser (mutante de 2.7) ⇒ S1 (4.5) debe fallar.
      Revertir el mutante. **Matado por**: S1 (`anulado` esperado `true`, recibido `false`) — y de
      yapa S2 y S5 también (el `continue` se come TODOS los residuos de S5, dejando pasar la página sin
      disparar el guard).
- [x] 8.3 Revert-probe: `mapGrReceipt` vuelve a `anulado: false` hardcoded (mutante de 2.5) ⇒ S1 + S2 +
      U2 (2.4) deben fallar. Revertir. **Matado por**: los 3 — S1/S2 en `finance-receipts-ingest-
      seam.test.ts`, U2 en `mapGrReceipt.test.ts` ("a receipt with a real fechaAnulacion maps to
      anulado: true", esperado `true` recibido `false`). S5 cae también de yapa.
- [x] 8.4 Revert-probe: se borra el guard sistémico (mutante de 3.2/4.3) ⇒ S5 (4.10) debe fallar
      (`rows.size !== 0`). Revertir. **Matado por**: S5 — `execute()` resuelve en vez de rechazar,
      `receiptRepo.rows.size` queda en 100 en vez de 0.
- [x] 8.5 Revert-probe: `annulmentGuardMaxPct = 100` inyectado saltando el normalizador ⇒ U5 (1.3) lo
      rechaza Y S5 (4.10) con config default sigue abortando. Revertir. **Matado/confirmado por**: U5
      (3 tests, esperado `5` recibido `100`) mientras S5 se mantuvo VERDE (usa el default 5%, nunca
      configurado a 100 — confirma que las dos protecciones son independientes).
- [x] 8.6 Revert-probe: se saca `anulado: false` de UNO de los cuatro lectores del dashboard (rotar los
      4) ⇒ D1-D4 (el afectado) + D5 (7.8) fallan; repetir la misma quita en su gemelo in-memory. Revertir
      cada uno (scenario 26). **Las 6 rotaciones ejecutadas**: D1 Prisma (2 tests), D2 Prisma (1 test),
      D3 Prisma (2 tests), D4 Prisma (1 test), gemelo in-memory de Item (2 tests D1/D2-in-memory + D5
      con `revenueTotalArs` 13000≠5000), gemelo in-memory de Application (2 tests D3/D4-in-memory + D5
      con `unclassifiedAmountArs` 2100≠900). Los 4 métodos in-memory comparten UNA sola línea de filtro
      por archivo (listByClientAndMonth llama a listByMonth), así que sacarla mata D1+D2 (o D3+D4)
      juntos en una sola quita — coherente con el diseño, no un atajo.
- [x] 8.7 Revert-probe: `reconcileWindowDays = 0` saltando el normalizador ⇒ U5 (1.4) lo rechaza (cae a
      35) Y U6 (4.2) con `0` forzado en DB igual pide un rango real de 35 días. Revertir. **Hueco
      cerrado**: no existía un test U6 a nivel USE CASE que probara "0 forzado -> igual pide 35 días
      reales" — se agregó (`SyncGrReceiptsReconcileWindow.test.ts`). **Matado por**: U5 (2 tests) Y el
      U6 nuevo — con el mutante, la ventana colapsó a `fechaDesde: "11-08-2026"` > `fechaHasta:
      "10-08-2026"` (ventana INVERTIDA, la manifestación literal de "feature inerte").
- [x] 8.8 Revert-probe: `isRealAnnulment` vuelve a fail-open (mutante de 2.3) ⇒ U1 (2.1/2.2) falla
      (ISO→`true` esperado, basura→`true` esperado, ambos vuelven a `false`). Revertir. **Matado por**:
      U1, 5 tests (32-13-2026, 2026-13-45, 2026-2026-2026 + 2 más), todos esperaban `true` y recibieron
      `false`.
- [x] 8.9 Revert-probe: se saca `syncReconcile` del wiring (mutante de 6.1) ⇒ pin de aridad `@ts-expect-
      error` (6.3) + throw del constructor (6.4) + S6 (5.7) deben fallar. Revertir. **Matado por**:
      `tsc` (TS2554 "Expected 6-7 arguments, but got 5" — el archivo entero deja de compilar, el pin de
      tipos funciona) Y el pin de texto del composition-root ("new FinanceReceiptIngestScheduler(...)
      no menciona syncReconcile"). **Nota**: S6 en sí no se ve afectado por ESTE mutante específico —
      S6 construye su propio scheduler en el test, no pasa por bootstrap; el pin de tipos + el de texto
      ya cubren el caso de wiring perdido con evidencia más fuerte (falla de compilación global).
- [x] 8.10 Revert-probe: el reconcile queda sin F4 (siempre due, nunca cede, mutante de 5.4) ⇒ S6 (5.7,
      `backfillState.itemsSynced > 0` tras N ticks) debe fallar. Revertir. **Hueco encontrado y
      cerrado**: el S6 original (delta envenenado) NO mataba este mutante — con `resultados:'1'`
      fijo en el fixture, el barrido de reconcile cierra en UNA página siempre, así que nunca queda
      "perpetuamente due" y F4 nunca entra en juego en ese fixture. Se agregó un segundo test S6
      (reconcile envenenado en persistencia, delta sano y silencioso) que SÍ deja a reconcile
      perpetuamente due. **Matado por**: el S6 nuevo — `backfillState.itemsSynced` esperado `>0`,
      recibido `0` (backfill starveado del todo).
- [x] 8.11 Revert-probe: se retira el filtro `anulado` de `PrismaPortalPaymentsReader` ⇒ su test (7.12)
      debe fallar con el fixture que incluye el recibo anulado real de monto ≠ 0 (scenario 28). Revertir.
      **Matado por**: PAY-1.5 preexistente Y el test nuevo de 7.12 (con el mock filtrando de verdad, el
      resultado quedó vacío — `where.anulado` pasó a `undefined`, ninguna fila matchea).

## Fase 9 — Gate: lo existente pasa SIN TOCARSE

- [ ] 9.1 Correr sin modificar: `SyncGrReceiptsDelta.test.ts`, `SyncGrReceiptsBackfillBatch.test.ts`,
      `finance-receipts-ingest-seam.test.ts` (casos R1/F4/F5/F12/F14) tras el refactor de la Fase 3.5 —
      deben quedar en VERDE. Si hay que tocar alguno, PARAR y reportar (el refactor cambió
      comportamiento). Cubre también scenarios 5 (page failure no aborta), 9, 10, 11 (backfill/delta
      preexistentes, sin cambios).
- [ ] 9.2 Confirmar y anotar en la matriz qué test PREEXISTENTE (sin cambios) cubre scenarios 2
      (dict-keyed nodes normalizados, `GestionRealClient.receipts.test.ts` F11/F12), 3 (aplicaciones
      1-a-N) y 4 (items+retenciones en sus tablas) — no se tocan, se listan como gate.
- [ ] 9.3 `npm test` — suite completa en verde.
- [ ] 9.4 `tsc --noEmit` — sin errores de tipos (valida en particular el pin de aridad de 6.3).

## Fase 10 — Verificación FE + rollout/runbook

- [ ] 10.1 Verificación READ-ONLY en `ipnext-frontend`: confirmado (2026-08-10) que
      `src/types/financeGrowth.ts:214` define `activeLane: 'delta' | 'backfill' | 'idle'` — union
      CERRADO, sin `'reconcile'`. Hoy `activeLane` NO se renderiza en ningún diccionario de labels de
      `FinanceGrowthOverviewPage.tsx` (solo vive en el tipo y en tests), así que no hay una UI que hoy
      quede en blanco — pero el tipo queda desalineado en cuanto el BE devuelva `'reconcile'`. Dejar
      anotado como **change FE coordinado pendiente**: ampliar el union type y, si se agrega un label
      visual, el diccionario de textos.
- [ ] 10.2 Pre-flight bloqueante: `SELECT "backfillFloorYearMonth" FROM "FinanceReceiptSyncConfig";` en
      prod — RE-verificar en el momento del re-arm que sigue en `2026-05` (verificado 2026-08-10, puede
      haber cambiado). Si está por debajo, subirlo temporalmente ANTES de disparar `rearm-backfill`
      (evita ~18 h de carril).
- [ ] 10.3 Deploy: `prisma migrate deploy` + código. Verificar a los ~2 min que aparece la fila
      `finance-receipts-reconcile` en `SyncState` con `lastResult` de página o barrido.
- [ ] 10.4 Catch-up: `POST /api/finance/sync/rearm-backfill` (permiso `finance:sync`). Monitorear avance
      mes a mes (`finance-receipts-backfill` en `SyncState`), ~67 min a ~2 h.
- [ ] 10.5 Verificación discriminante de los 102 IDs: tomar la lista de los 102 `grReceiptId` faltantes
      del 05-08 desde el engram `gr/recibos-confirmacion-tardia` (o el artefacto/output crudo del probe
      del orquestador del 2026-08-10) — NO recalcular de cero. Correr
      `SELECT count(*) FROM "FinancePaymentReceipt" WHERE "grReceiptId" IN (…102 ids…);` — esperado
      exactamente `102`. El conteo agregado del día (299) NO alcanza como evidencia por sí solo.
- [ ] 10.6 Verificar el faltante suelto del 01-07: `SELECT * FROM "FinancePaymentReceipt" WHERE
      "grReceiptId" = '345867';` — esperado 1 fila (prueba que no es efecto de un solo día).
- [ ] 10.7 Verificar que el espejo NO se volcó: `SELECT count(*) FROM "FinancePaymentReceipt" WHERE
      anulado = true;` — esperado 0 o un puñado explicable; si son miles, el guard falló, ver rollback.
- [ ] 10.8 Verificación del guard en logs: si el guard disparó durante el catch-up, confirmar en logs que
      el pacing de GR (`effectiveIntervalMs`) NO escaló a `maxRequestIntervalMs` (evidencia de que
      `trackGrHealth` no lo culpó — Decisión 4/3.3-3.4).
- [ ] 10.9 `POST /api/finance/sync/backfill-snapshots` acotado a `2026-05..2026-08`, recién después de
      que 10.5 dé `102`. Verificar que la caja cobrada de `2026-08` SUBE respecto del valor anotado
      antes del catch-up.
- [ ] 10.10 Régimen: a las ~6 h del deploy, confirmar `lastResult = 'sweep ok …'` en
      `finance-receipts-reconcile`; revisar logs por `masViejoReparado >= 32d` (borde de ventana) — si
      aparece, subir `reconcileWindowDays` por SQL.

---

## Apéndice — Matriz scenario → tarea

### `finance-growth` (21 scenarios)

| # | Scenario | Tarea(s) |
|---|---|---|
| 1 | Receipt con fecha_anulacion real se persiste anulado=true, nunca skip | 2.6, 2.7, 4.5 |
| 2 | Dict-keyed GR nodes normalizados a listas | 9.2 (existente, gate) |
| 3 | Aplicaciones 1-a-N | 9.2 (existente, gate) |
| 4 | Items/retenciones en sus tablas junto a aplicaciones | 9.2 (existente, gate) |
| 5 | Fallo de una página no aborta el batch | 9.1 (existente, gate) |
| 6 | Delta gana el tick sobre reconcile y backfill | 5.1, 5.4 |
| 7 | Reconcile gana el tick cuando delta está quieto y su cadencia venció | 5.2, 5.4 |
| 8 | Backfill no se starvea indefinidamente | 5.3, 5.4 |
| 9 | Backfill camina meses newest→oldest, una página por turno | 9.1 (existente, gate) |
| 10 | Backfill resumable mid-page, se detiene en el floor | 9.1 (existente, gate) |
| 11 | Delta avanza con overlap en cadencia real-time | 9.1 (existente, gate) |
| 12 | Fallos repetidos degradan el pacing compartido de los 3 carriles | 5.7, 5.8, 9.1 |
| 13 | Reconcile caza confirmado tarde | 4.4 |
| 14 | Re-barrer la misma ventana no duplica filas | 4.8 |
| 15 | Invariante ventana-vs-rebuild se hace cumplir | 1.7 (**ver nota de hueco abajo**) |
| 16 | Sobre de error de GR durante reconcile nunca degrada a escritura vacía | 4.9 |
| 17 | ISO reconocido como fecha válida no anulada | 2.1, 2.2 |
| 18 | Centinela todo-ceros en cualquier ancho/orden sigue "no anulado" | 2.2 |
| 19 | Residuo no parseable marca solo esa fila | 2.2, 3.1, 4.10 |
| 20 | Corrida normal con 0/pocos anulados persiste normal | 3.1 |
| 21 | Drift del centinela satura la página y aborta sin escribir | 3.1, 4.10 |

### `finance-dashboard-annulment-filter` (5 scenarios)

| # | Scenario | Tarea(s) |
|---|---|---|
| 22 | Items de recibo anulado excluidos de la caja mensual | 7.1 |
| 23 | Items de recibo anulado excluidos del total mensual de un cliente | 7.2 |
| 24 | Aplicaciones de recibo anulado excluidas de unclassifiedAmountArs | 7.3, 7.8 |
| 25 | Aplicaciones de recibo anulado excluidas de la atribución CAC/payback | 7.4, 7.10 |
| 26 | Revert-probe: sacar el filtro de cualquiera de los 4 pone su test en rojo | 7.6, 8.6 |

### `portal-payments` (3 scenarios)

| # | Scenario | Tarea(s) |
|---|---|---|
| 27 | Recibo anulado por el reconcile desaparece de Mis pagos en la próxima lectura | 4.6, 7.12 |
| 28 | Revert-probe: retirar el filtro pone el test en rojo | 7.12, 8.11 |
| 29 | Recibo nunca anulado sigue apareciendo sin cambios | 7.12 (gate, WHERE preexistente) |

### Hueco reportado (no inventado)

**Scenario 15** (`finance-growth`, "The window-vs-rebuild invariant is enforced"): el requirement pide
que configurar `reconcileWindowDays` por debajo de la ventana de rebuild (mes corriente + anterior, peor
caso 35 días) se **rechace o acote al mínimo válido**. La Decisión 7 del design solo especifica un rango
estático `[1, 90]` con fallback a `35` para basura/fuera de rango — un valor "válido pero riesgoso" como
`20` cae DENTRO de `[1, 90]` y el normalizador tal como está descripto NO lo tocaría, lo cual no satisface
el scenario 15 literalmente. La tarea 1.7 interpreta el mínimo efectivo como `35` (coincide con el
default) para cerrar el requirement, pero es una lectura mía, no una decisión explícita del design — 
`sdd-verify` debe confirmarla o el equipo debe resolver la ambigüedad antes de archivar.
