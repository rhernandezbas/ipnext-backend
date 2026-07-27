# Review adversarial — `iclass-gps-audit` (2026-07-26)

4 revisores independientes con focos separados. **Ningún hallazgo llegó a producción**: el change está en el worktree `iclass-gps-audit-be`, sin commitear.

Gate al momento del review: `npm test` 1.000 suites / 9.961 tests verdes, `tsc` exit 0. **Todos estos bugs pasaron el gate.** Es la evidencia de por qué el review adversarial es obligatorio y no escalable por riesgo.

Leyenda: `[ ]` pendiente · `[x]` arreglado · `[~]` refutado tras verificación propia.

---

## BLOQUE 1 — Producen ACUSACIONES INJUSTAS (máxima prioridad)

Todos violan el principio central del change: *un punto nunca es prueba de ausencia; ante duda, `NO_CONCLUYENTE`*.

- [x] **1.1 🔴 Ventana truncada sin `FECHADA`** — **ARREGLADO 2026-07-26.** `workWindow.ts` reescrito con modelo de CICLOS (`computeExecutionCycles` / `relevantCycle`). Sin evento de cierre → `computeWorkWindow` devuelve `null` (el consumidor degrada a `NO_CONCLUYENTE`), ya no se trunca en el último estado de ejecución. `ENCERRADO` agregado a `CLOSING_STATUSES`. El test `workWindow.test.ts` que consagraba el comportamiento peligroso fue **corregido** y ahora asserta `toBeNull()`. +9 tests nuevos en `executionCycles.test.ts`.
  <br>ORIGINAL: — `workWindow.ts:77,81`. Sin evento de cierre, `end = lastExecution`, que es cuando el técnico *empieza* el viaje. Se audita el tramo de ruta → `FUERA_DE_SITIO`. Además `CLOSING_STATUSES` no incluye **`ENCERRADO`**, que existe en el histórico real. **El test `workWindow.test.ts:55-64` consagra el comportamiento peligroso como correcto.**
- [x] **1.2 🔴 Ciclos múltiples de ejecución** — **ARREGLADO 2026-07-26.** Además de los ciclos, se agregó `DISPATCH_RESET_STATUSES` (`AGENDADA`, `DESPACHADA`, `DESPACHADA EMPREITEIRA`, `ASSOCIADA EQUIPE`, `EM ANALISE`, `PRE ABERTA`, `ABERTA`): un estado que devuelve la orden a despacho **abandona el ciclo en curso sin cerrarlo**, así dos intentos distintos nunca se fusionan. `relevantCycle` elige el ÚLTIMO ciclo CERRADO. `executionDurationMinutes` mide ese ciclo y devuelve `null` si no hay ninguno cerrado (arregla también 1.11: ya no marca órdenes en curso). **El primer intento de fix seguía fusionando el rebote de 9 días; lo cazó el test escrito antes.** `ExecutionCycle` ahora lleva `teamLogin` por ciclo (insumo para 1.3).
  <br>ORIGINAL: — `workWindow.ts:74-81`. `start` = primer evento de ejecución de TODO el histórico. Con reejecución se audita el ciclo equivocado; con rebote (la 4995 rebotó 9 días) la ventana abarca 9 días → absuelve automáticamente Y `executionDurationMinutes` da ~13.000 min, o sea **el caso testigo del pre-filtro dejaría de detectarse**. Misma raíz que 1.1: no se modelan ciclos.
- [x] **1.3 🔴 Cuadrilla reasignada: se audita a la persona equivocada** — **ARREGLADO 2026-07-26.** La cuadrilla auditada sale ahora del CICLO del histórico (`relevantCycle().teamLogin`), con fallback a la asignada sólo si el histórico no la informa. `SoStatusEvent` lleva `teamLogin` por evento.
  <br>ORIGINAL: — `AuditServiceOrderPresence.ts:114-116,126-128`. Se descarta `h.teamLogin` (que SÍ viene por evento, `IClassClient.ts:898`) y se pide el rastro de `order.teamLogin` (el actual). La ventana sale de la cuadrilla A y el rastro de la B. La 4995 ya diverge: `equipe=IPNXANDYM`, cerrada por `IPNXLUISS`.
- [x] **1.4 🔴 Punto elegido por distancia CRUDA, precisión restada después** — **ARREGLADO 2026-07-26.** Se minimiza la COTA INFERIOR `d − precisión` en vez de la distancia cruda. La distancia CRUDA se sigue reportando como evidencia en `minDistanceMeters`.
  <br>ORIGINAL: — `presenceEvaluation.ts:143-166`. Verificado numéricamente: P1 a 199,8 m con `raio` 8 (→191,8) gana sobre P2 a 244,7 m con `raio` 100 (→144,7, compatible con estar en el domicilio) → **`FUERA_DE_SITIO` teniendo la prueba en la mano**. Hay que minimizar la cota inferior `d − accuracy` y reportar la distancia cruda aparte.
- [x] **1.5 🔴 Un solo punto alcanza para condenar** — **ARREGLADO 2026-07-26.** Piso de cobertura: `minPointsToCondemn` (3) y `maxCoverageGapMinutes` (20) — un hueco mayor degrada a NO_CONCLUYENTE. ASIMETRÍA DELIBERADA: un punto SÍ prueba presencia, pero no ausencia. Se expone `largestCoverageGapMinutes` como evidencia.
  <br>ORIGINAL: — `presenceEvaluation.ts:166-169`. Sin piso de cobertura. Un único fix a las 20:45 con el técnico ya saliendo → condena, aunque estuvo a las 20:20 sin muestreo. Falta mínimo de puntos y/o cobertura temporal de la ventana (huecos > X min → `NO_CONCLUYENTE`).
- [x] **1.6 🔴 `orders[0]` sin verificar código exacto** — **ARREGLADO 2026-07-26.** Guard `orders.find(o => String(o.iclassCodigo) === String(code))`, igual que `IClassClient.getServiceOrder`. El motivo del NO_AUDITABLE ahora dice cuántos días abarca la búsqueda.
  <br>ORIGINAL: — `AuditServiceOrderPresence.ts:104`. **El mismo repo ya documenta y aplica el guard**: `IClassClient.ts:433-434` (*"the IClass filter may behave as a LIKE/prefix match"*) y `:449` usa `matches.find(...)`. Pidiendo `499` se puede auditar la `4995`, y la línea 141 devuelve el código de ENTRADA, así que el reporte no delata el desvío.
- [x] **1.7 🟡 `raio` ausente → `accuracyMeters = 0` = precisión perfecta** — **ARREGLADO 2026-07-26.** `accuracyMeters` pasó a `number | null` en la entidad, el parser y la columna (`accuracyM Float?`). Precisión desconocida o negativa => `null`: puede probar presencia, nunca condenar. Si NINGÚN punto de la ventana informa precisión => NO_CONCLUYENTE.
  <br>ORIGINAL: — `IClassClient.ts:1044,1052`. Default INVERTIDO: la duda debe favorecer al técnico y acá lo condena. Debe ser `null` (no apto para condenar) o descartar el punto. Tampoco se valida `accuracy >= 0`.
- [x] **1.8 🟡 Domicilio `(0,0)` y coma decimal pasan como válidos** — **ARREGLADO 2026-07-26.** Guard de `Number.isFinite` sobre el domicilio + rechazo explícito de (0,0) como NO_AUDITABLE (Null Island). El parser usa `toFiniteNumber`, que NO acepta `null` ni cadena vacía (antes `Number(null)===0` pasaba el guard).
  <br>ORIGINAL: — `AuditServiceOrderPresence.ts:120-123` sólo chequea `!== null`. Null Island → 7.249.686 m → condena demoledora. Y `numOrNull` usa `parseFloat`: `"-34,70084"` → `-34` (78 km de desvío, sin error). Asimetría peligrosa: los breadcrumbs usan `Number()` (da `NaN`, se descartan) pero el domicilio —el dato que decide— usa el parser más laxo.
- [x] **1.9 🟡 `evaluatePresence` no verifica que los puntos sean de la cuadrilla** — **ARREGLADO 2026-07-26.** Filtro `p.teamLogin === input.teamLogin` en el dominio. DESTAPÓ que un test viejo pasaba logins cruzados y nadie lo había notado.
  <br>ORIGINAL: — `presenceEvaluation.ts:106-129`. `teamLogin` sólo se usa como chequeo de null. Un `filter(p => p.teamLogin === input.teamLogin)` de una línea lo cierra para siempre.
- [x] **1.10 🟡 `NaN` produce `FUERA_DE_SITIO`** — **ARREGLADO 2026-07-26.** Se descartan los puntos con coordenadas o timestamp no finitos ANTES de evaluar. Si todos son corruptos => NO_CONCLUYENTE.
  <br>ORIGINAL: — `presenceEvaluation.ts:143-166`. `NaN < NaN → false`, así que un punto corrupto al frente del array nunca se reemplaza y `NaN <= threshold → false` → condena. El fail-open apunta hacia la acusación.
- [x] **1.11 🟡 `ListSuspiciousClosures` marca órdenes ABIERTAS en curso** — **ARREGLADO 2026-07-26.** `executionDurationMinutes` devuelve `null` si no hay ciclo CERRADO, así que una orden en curso ya no puede aparecer como cierre sospechoso.
  <br>ORIGINAL: — `:53-56`. `listServiceOrders` no filtra por estado. Un técnico que puso `DESLOCAMENTO` hace 3 minutos encabeza la lista de "cierres sospechosos", con nombre y apellido. Falso positivo sistemático en cada barrido.
- [x] **1.12 🟡 El texto de `NO_CONCLUYENTE` afirma una causa que no se puede conocer** — **ARREGLADO 2026-07-26.** El motivo describe lo que el sistema SABE ("no hay registros en la base para la ventana"), sin afirmar por qué faltan.
  <br>ORIGINAL: — `presenceEvaluation.ts:135-137` dice *"el equipo pudo no estar reportando"*. Hay 4 causas indistinguibles (no reportaba / el ingest no corrió / la purga ya borró / la OS es anterior al ingest). Cruzar contra `TeamLocationIngestRun` para distinguirlas.
- [ ] **1.13 🟡 La ventana usa el parser de infraestructura, no el endurecido** — `AuditServiceOrderPresence.ts:116` hace `new Date(h.occurredAt)` sobre lo que produjo `parseIClassDate`, cuya rama ISO (`IClassClient.ts:820-823`) interpreta en TZ del proceso → 3 h de corrimiento en prod. Es el bug de `isoDate()` de GR que el propio docblock de `iclassDateTime.ts` cita como precedente.

## BLOQUE 2 — PIERDEN DATOS EN SILENCIO

- [x] **2.1 🔴 El rate-limit de IClass (HTTP 200 + texto plano) se cuenta como página vacía** — **ARREGLADO 2026-07-26.** `isRateLimited()` agregado a `listTeamLocations` (devuelve `incomplete:true`) y a `listTeamLocationDescriptors` (lanza `IClassUnavailableError` en vez de devolver roster vacío).
  <br>ORIGINAL: — `IClassClient.ts:606-616`. **`listTeamLocations` es el ÚNICO método del cliente que no llama `isRateLimited()`** (lo hacen `fetchAllPages:302`, `closeServiceOrder:479`, `updateServiceOrder:683`, `authedGetOrNull:726`). Dos seguidas → corte con `incomplete: FALSE`. El primer run son ~770 GETs sin throttle: es el escenario esperable. Ídem `listTeamLocationDescriptors` → roster vacío en silencio.
- [x] **2.2 🔴 RATCHET del watermark: hueco PERMANENTE** — **ARREGLADO 2026-07-26.** RATCHET ROTO. Modelo nuevo `TeamLocationIngestState` con `contiguousWatermark`, que **sólo avanza tras una lectura COMPLETA**. Lo leído en una corrida parcial se persiste igual (el dato expira en 30 días), pero el watermark no se mueve, así que la corrida siguiente vuelve a pedir desde antes del hueco. Se cuenta `consecutiveIncomplete` para poder alertar.
  <br>ORIGINAL: — `IngestTeamLocations.ts:58-68`. El rastro es descendente, así que una lectura parcial trae los puntos MÁS NUEVOS; se persisten (correcto en aislamiento) pero `findWatermark = MAX(recordedAt)` **salta por encima del hueco**. La corrida siguiente corta en página 1 y reporta limpio. La cola no se vuelve a pedir jamás e IClass la purga a los 30 días. **`incomplete: true` hoy es decorativo**: no dispara backfill, ni degrada el watermark, ni alerta. Espejo del bug del commit `89a6fdb7` (mismo día), pero peor: aquél se auto-curaba, éste no.
- [x] **2.3 🔴 Salir por `LOCATIONS_MAX_PAGES` devuelve `incomplete: false`** — **ARREGLADO 2026-07-26.** Salir por `LOCATIONS_MAX_PAGES` devuelve `incomplete: true`.
  <br>ORIGINAL: — `IClassClient.ts:592,634`. El backstop contra el loop infinito es también un truncador silencioso. Margen real 1,4x (el adapter pagina sobre el stream CRUDO, con `origem` duplicado; la dedup es del repo).
- [x] **2.4 🔴 Puntos ilegibles descartados sin contarse** — **ARREGLADO 2026-07-26.** `pointsDropped` en `TeamTrailPage` → `IngestRunSummary` → columna `TeamLocationIngestRun.pointsDropped`. Además, una página LLENA de la que no se parsea NADA marca el rastro incompleto (detecta un cambio de contrato de la API).
  <br>ORIGINAL: — `IClassClient.ts:620-628`. Si IClass migra `dataRegistro` a ISO: `teams=11 new=0 pages=2200 incomplete=[]` — **éxito perfecto sobre cero datos**. Y no hay síntoma colateral porque `parseIClassDate` (mismo archivo) SÍ acepta ISO. Falta `pointsDropped` en `TeamTrailPage` → `IngestRunSummary`.
- [x] **2.5 🔴 `Number(null) === 0` pasa el guard de finito** — **ARREGLADO 2026-07-26.** `toFiniteNumber` acepta sólo `number` o string no vacía: `null`/`''` ya no colapsan a 0 (antes pasaban el guard de finito y entraban como punto en el Golfo de Guinea).
  <br>ORIGINAL: — `IClassClient.ts:1035-1053`. `null`/`''` → `0` → punto válido en el Golfo de Guinea. (`undefined` → `NaN` sí se descarta.)
- [x] **2.6 🟡 Watermark con `<=` sacrifica puntos legítimos** — **ARREGLADO 2026-07-26.** Watermark ESTRICTO (`<` en vez de `<=`): dos puntos del mismo instante con distinta coordenada son filas legítimas para el unique y ya no se pierde el segundo.
  <br>ORIGINAL: — `IClassClient.ts:623`. La dedup de base ya da idempotencia, así que `<=` no compra nada y descarta el segundo punto del mismo instante con distinta coordenada (que el unique permite). Debe ser `<`.
- [x] **2.7 🟡 Breadcrumbs bufferados offline: hueco por diseño** — **ARREGLADO 2026-07-26.** Solapamiento de 2 h sobre el watermark: cubre breadcrumbs bufferados offline que llegan con timestamp anterior. Releer es gratis porque el unique deduplica.
  <br>ORIGINAL: — misma línea. Un celular sin señal sube fixes con timestamp anterior al watermark → descartados para siempre. Es el caso que la auditoría más necesita resolver. Un solapamiento fijo (watermark − 2h) lo cubre gracias al unique.
- [x] **2.8 🟡 Un timestamp futuro envenena el watermark por años** — **ARREGLADO 2026-07-26.** Cota superior de cordura (+1 h sobre `now`): un timestamp futuro se descarta y ya no puede volverse el watermark y bloquear el ingest por años.
  <br>ORIGINAL: — sin cota superior en `parseTeamLocationPoint`. Un `26-07-2036` deja todos los puntos reales bajo el watermark → 0 puntos nuevos, `incomplete:false`, por diez años, y requiere intervención manual que nadie sabría que hace falta.
- [ ] **2.9 🟡 El `catch` no distingue naturalezas de error** — `IClassClient.ts:598-602`. 404/400/401 persistente son permanentes y quedan `incomplete` en cada corrida sin escalar. Y un 401 que llega con `attempt >= 1` **no re-loguea** (`:395`) → si el token vence durante el backoff de un 429, muere la paginación de esa cuadrilla. Además el catch aborta el resto de la paginación en la primera página que falla.
- [x] **2.10 🟡 Rechazos no capturados en el scheduler** — **ARREGLADO 2026-07-27.** `flags.get` y `lock.tryAcquire` movidos DENTRO del `try` (los callers usan `void runOnce()`, así que un parpadeo de PG era unhandled rejection → proceso muerto en Node ≥15). El `release` del `finally` va envuelto para no pisar el `return` de una corrida exitosa.
  <br>ORIGINAL: — `TeamLocationIngestScheduler.ts:71,77,100`. `flags.get()` y `lock.tryAcquire()` están ANTES del `try`; con `void this.runOnce()` un parpadeo de PG es **unhandled rejection** (en Node ≥15 mata el proceso). Y `lock.release()` en el `finally` puede rechazar pisando un `return` exitoso.
- [x] **2.11 🟡 Sin cache ni throttle contra IClass** — **ARREGLADO 2026-07-27.** Cache de 5 min del roster en `IClassTeamLocationSource` (el mapa en vivo llamaba a IClass en CADA request). **Sólo se cachea un resultado NO vacío**: un roster vacío por fallo transitorio no queda congelado 5 minutos haciendo desaparecer a todas las cuadrillas.
  <br>ORIGINAL: — `GetTeamsLiveStatus.ts:60` llama `source.listTeams()` en CADA request del mapa. Ingest de 770 páginas + dashboard poleando + closure loop → "Espere um pouco" garantizado, y ahí se dispara 2.1.

## BLOQUE 3 — SEGURIDAD

- [x] **3.1 🔴 El split de permisos está derrotado: `/:login/journey` bajo `location_read`** — **ARREGLADO 2026-07-27.** Gate DINÁMICO en `/:login/journey`: la jornada de HOY/AYER va con `location_read` (despacho la necesita para operar); cualquier día anterior exige `location_audit`. Se rechaza además la fecha futura. Ya no se puede reconstruir un año de horarios de entrada/salida con el permiso operativo.
  <br>ORIGINAL: — `technicianLocation.routes.ts:107`. Acepta CUALQUIER fecha y la retención es de 12 meses. Devuelve `firstPointAt`/`lastPointAt` (**hora de entrada y salida**) y el histograma horario. Un rol `noc` pide `/live` (roster completo con todos los logins) e itera 365 días por persona → **vigilancia laboral de un año sin `location_audit`**. Fix propuesto: jornada de hoy/ayer bajo `location_read`, histórico bajo `location_audit`.
- [x] **3.2 🔴 Ignora la revocación de sesión — único router del repo** — **ARREGLADO 2026-07-27.** `sessionRepo` agregado a las deps del router y cableado en `app.ts`. `createAuthMiddleware` vuelve a ser stateful, así que revocar una sesión SÍ cierra estas rutas. Pineado en el composition-root test.
  <br>ORIGINAL: — `technicianLocation.routes.ts:49`, `app.ts:2323`. `createAuthMiddleware` es stateful sólo con `sessionRepo`; sin él cae al chequeo legacy JWT-only. **~30 call sites del repo lo pasan; éste no, y la interfaz de deps ni tiene el campo.** Se revoca la sesión de un ex-empleado y sigue viendo el GPS de todas las cuadrillas hasta 8 h.
- [x] **3.3 🟡 Rango sin cota → DoS de la integración IClass ENTERA** — **ARREGLADO 2026-07-27.** La ruta valida calendario REAL (rechaza `2026-02-31` en vez de dejar que `Date.UTC` desborde a otro día), exige `from <= to` y topea el rango en 30 días ANTES de tocar IClass.
  <br>ORIGINAL: — `routes:54-76`, `ListSuspiciousClosures.ts:52-63`. `DAY_RE` acepta `9999-99-99`; no hay tope de rango ni `from <= to`; después un `getServiceOrderHistory` **en serie por orden**. Un solo GET satura IClass y **rompe el closure loop y la creación de OS de toda la empresa**. `AuditServiceOrderPresence` sí se autolimita a 29 días; esto no.
- [x] **3.4 🟡 `respondError` filtra internos** — **ARREGLADO 2026-07-27.** `respondError` sólo expone el mensaje de errores de DOMINIO (502 con `code`); cualquier otra cosa devuelve `Internal server error` genérico con 500 y se loguea aparte. Mismo criterio que `errorHandler.ts`. Test que verifica que no se filtren rutas del filesystem ni `prisma.`.
  <br>ORIGINAL: — `routes:143-146`. Devuelve `err.message` sin discriminar; los errores de Prisma incluyen **rutas absolutas del filesystem** y el host del datasource. El `errorHandler.ts` del repo sanea todo lo que no sea `DomainError`; los otros 502 del repo sólo exponen errores de dominio tipados.
- [x] **3.5 🟡 PII de clientes por puerta lateral** — **ARREGLADO 2026-07-27.** `customerName` y `addressLine` sacados de AMBOS payloads de auditoría. Para responder "¿estuvo o no estuvo?" alcanzan las coordenadas; los datos del cliente se piden al módulo `clients`, con su permiso.
  <br>ORIGINAL: — `AuditServiceOrderPresence.ts:144-145`, `ListSuspiciousClosures.ts:82-85`. `customerName` + `addressLine` bajo el módulo `technicians`: alguien con `location_audit` y sin `clients.read` se lleva un export masivo del padrón. Para el veredicto alcanzan las coordenadas.
- [x] **3.6 🟢 `thresholdMinutes` se valida y nunca se pasa** — **ARREGLADO 2026-07-27.** `thresholdMinutes` viaja al use case por llamada (`execute({from,to,thresholdMinutes})`) y la respuesta devuelve `meta.thresholdMinutes` para que el operador vea con qué umbral se calculó.
  <br>ORIGINAL: — `routes:65-70`. El use case lo toma por constructor y `app.ts:2320` lo instancia sin él → queda fijo en 5. Un auditor pide 30, recibe 200, y concluye que no hay más casos. Falsa parametrización.
- [x] **3.7 🟢 Ningún test cubre que el auth se aplique** — **ARREGLADO 2026-07-27.** Test negativo agregado: router CON `authProvider` y sin cookie → 401. Antes ningún test cubría la línea del auth middleware, así que borrarla dejaba todo verde.
  <br>ORIGINAL: — los 9 tests construyen el router SIN `authProvider` y obtienen 200. Si alguien borra la línea 49, todo sigue verde. (Verificado: el camino falla cerrado vía `NO_USER_CONTEXT`, no hay bypass — pero falta el test negativo.)
- [x] **3.8 🟢 El composition-root test es más débil de lo que promete** — **ARREGLADO 2026-07-27.** El composition-root test ahora verifica también `sessionRepo` y que `/api/technicians` se monte EXACTAMENTE UNA VEZ (un mount previo shadowearía estas rutas con el test en verde).
  <br>ORIGINAL: — `indexOf` toma la PRIMERA ocurrencia (un router montado antes en `/api/technicians` lo shadowearía con el test en verde); `toContain('new PrismaTeamLocationRepository()')` matchea en todo el archivo; y afirma `authProvider: authAdapter` sin verificar que el router lo USE.

## BLOQUE 4 — PERSISTENCIA

- [x] **4.1 🔴 `findLatestPerTeam` NO genera `DISTINCT ON`** — **ARREGLADO 2026-07-27.** `findLatestPerTeam` usa `$queryRaw` con `SELECT DISTINCT ON ("teamLogin")` REAL + índice `(teamLogin, recordedAt DESC)`. El test ahora asserta el SQL emitido, no los argumentos que se le pasan a Prisma — el anterior verificaba lo que PEDÍA, no lo que PASABA.
  <br>ORIGINAL: — `PrismaTeamLocationRepository.ts:90-97`. **Verificado empíricamente compilando el query**: Prisma 7 deduplica EN NODE (`distinctBy()` en `processManyRecords`). El SQL real no tiene `DISTINCT`, ni `WHERE`, ni `LIMIT`. A 432k filas son **~90 MB transferidos a Node por request** del mapa en vivo. **Mi comentario en el código afirma lo contrario y es falso.** Fix: `$queryRaw` con `DISTINCT ON` + índice `("teamLogin", "recordedAt" DESC)`.
- [x] **4.2 🔴 `findByTeamOnDay` con fecha imposible devuelve OTRO DÍA** — **ARREGLADO 2026-07-27.** `findByTeamOnDay` valida el calendario con round-trip y devuelve `[]` ante un día inexistente, en vez de servir el rastro de la fecha a la que `Date.UTC` desborda. Además el router ya rechaza esas fechas con 400.
  <br>ORIGINAL: — `:107-118`. `?day=2026-02-31` → `Date.UTC(2026,1,31)` desborda a **3 de marzo** → se sirve la jornada real del 3 de marzo etiquetada `"2026-02-31"`. **El in-memory devuelve `[]`** → divergencia exacta: el test contra in-memory pasa mientras prod entrega el historial de otro día de una persona.
- [x] **4.3 🟡 `skipDuplicates` pierde `sources` entre corridas** — **ARREGLADO 2026-07-27.** `saveMany` pasó de `createMany({skipDuplicates})` a `INSERT ... ON CONFLICT DO UPDATE` con unión de arrays (`unnest`), así que `sources` se mergea también ENTRE corridas. La contabilidad usa `xmax = 0` para distinguir insert de update fila por fila (con `$executeRaw` todas contarían como afectadas y los contadores mentirían). **Y se agregó `UPSERT_CHUNK_SIZE = 500`**: `createMany` chunkeaba solo, `$queryRaw` NO — sin eso, un backfill de 20.000 puntos daba 120.000 bind params contra el tope de 65.535, con fallo determinista y eterno. Detectado por mí al redactar el prompt de la re-review.
  <br>ORIGINAL: — `:76-79`. El in-memory mergea (su `Map` persiste); Prisma descarta la fila entera, nunca hace `ON CONFLICT DO UPDATE`. **Los contadores coinciden, los datos no**, por eso ningún assert lo detecta. Contradice la promesa escrita en `schema.prisma`, en la entidad y en el propio docblock del adapter.
- [x] **4.4 🟡 `retentionCutoff()` borra de más con meses cortos** — **ARREGLADO 2026-07-26.** `retentionCutoff()` acota el día al último día real del mes destino antes de construir la fecha; `setUTCMonth` desbordaba y podía dar un cutoff en el FUTURO que borraba días a conservar.
  <br>ORIGINAL: — `IngestTeamLocations.ts:91-94`. `setUTCMonth` desborda: con `retentionMonths: 1` una corrida del 31-03 da cutoff en el FUTURO y borra 3 días que debían conservarse. Borrado irreversible sobre un dato que IClass ya no tiene.
- [x] **4.5 🟢 Índice redundante** — **ARREGLADO 2026-07-27.** El índice pasó a `(teamLogin, recordedAt DESC)`: ya NO es redundante con el unique (que no sirve para el `ORDER BY ... DESC` del DISTINCT ON) y queda justificado por escrito en el schema.
  <br>ORIGINAL: — `schema.prisma:3635`. `@@index([teamLogin, recordedAt])` es prefijo estricto del unique. Cuesta un 4º btree por insert. Si se mantiene, que sea decisión escrita.
- [ ] **4.6 🟢 Divergencias menores in-memory ↔ Prisma** — orden de `findLatestPerTeam` (Prisma ordena, in-memory usa orden de inserción); empates de `recordedAt` no deterministas en Prisma (afecta `travelledMetersLowerBound`); `pointsDuplicate` mezcla colapsos intra-lote con rechazos del unique; constante de offset argentino duplicada con **signo invertido** entre `PrismaTeamLocationRepository.ts:10` y `iclassDateTime.ts`; una purga que falla aborta `recordIngestRun` y se pierde la observabilidad de una corrida que sí ingestó.

---

## REFUTADO tras verificación propia

- [~] **`createMany` sin chunkear → >65.535 bind params.** El revisor de adapter lo reportó 🔴; el de persistencia lo refutó empíricamente. **Verificado directamente en el runtime**: `@prisma/query-plan-executor` tiene `#providerMaxChunkSize()` que devuelve **32766** para postgres y `chunkArray(fragment.value, availableSize)`. Prisma 7 chunkea solo. **No hay fix que hacer.**

---

## Confirmado LIMPIO (verificado, no asumido)

- Migraciones puramente aditivas, timestamps correctos, **cero `BEGIN`/`COMMIT` internos**, nombre de constraint de 61 chars (< 63, sin truncamiento ni drift).
- **Idempotencia RBAC genuina y a prueba de DB fresca**: los roles los crea la migración foundation, que corre antes; segunda corrida = no-op total.
- **Floats en el UNIQUE sin bug**: btree de Postgres usa igualdad de bits; la clave JS es inyectiva sobre doubles; `TIMESTAMP(3)` == ms de `Date`.
- Contadores `inserted`/`duplicates` correctos en los 4 casos (el problema es `sources`, no el conteo).
- Cero inyección (todo parametrizado o vía `URLSearchParams`; ningún `$queryRaw`).
- Orden de rutas correcto: `/audit/*` antes de `/:login/journey`, probado en ambas direcciones.
- Ningún handler puede colgar la request (la lección de los dos barridos de 504 está aplicada).
- Clave del frontend correcta: `ResolveUserPermissions` emite `${moduleCode}.${action}` → `technicians.location_read` / `technicians.location_audit`, coincidencia carácter por carácter. Sin riesgo de página invisible ni sin gate.
- `authProvider` opcional **falla cerrado** (`NO_USER_CONTEXT`), sin bypass.
- El regex de acentos de `workWindow.ts` es correcto (codepoints volcados: `[̀-ͯ]`), aunque conviene escribirlo con escapes por robustez ante normalizadores de encoding.

---

## Nota de proceso

`openspec/changes/iclass-gps-audit/` vive sólo en el repo principal, **no está en la rama del change**. Hay que decidir si los artefactos SDD se commitean en la branch o quedan en `main`.

---

# RE-REVIEW FOCALIZADA — 2026-07-27

Segunda pasada adversarial, esta vez sobre los ~35 FIXES. Veredicto inicial: **NO CLEAN**.
Verificó todo **ejecutando código**, no leyendo — incluso revirtiendo fixes para comprobar
si algún test los protegía.

**Confirmó la lección de la W6: 4 de los bugs los introdujeron mis propios fixes.**

- [x] **R1 🔴 El piso de cobertura no cubría los BORDES de la ventana** — `largestGapMinutes` medía sólo entre puntos consecutivos. Probado en vivo: ventana de 4 h con 3 puntos apretados en los últimos 10 min → `FUERA_DE_SITIO` con `largestGap: 5`, teniendo 3 h 50 sin un solo muestreo. El fix 1.5 subía el precio de la acusación injusta de 1 punto a 3; no la eliminaba. **ARREGLADO**: la función ahora incluye `window.from → primer punto` y `último punto → window.to`.
- [x] **R2 🔴 Los fixes 1.3 y 1.6 no tenían NI UN test** — el revisor los revirtió y corrió 4.447 tests: todos verdes. Los dos fixes que impiden auditar la orden equivocada y a la persona equivocada eran borrables sin que nada se enterara (todos los fixtures tenían `order.teamLogin === history.teamLogin` y códigos exactos). **ARREGLADO**: dos tests nuevos que fallan al revertir.
- [x] **R3 🔴 El 1.3 NO se había arreglado en `ListSuspiciousClosures`** — el `.map()` ni propagaba `h.teamLogin` y la salida usaba `order.teamLogin`. Esta es la lista que un supervisor lee PRIMERO. Y el test `:67` **consagraba el comportamiento equivocado**. **ARREGLADO**: usa `relevantCycle().teamLogin`, no inventa el nombre del técnico si la cuadrilla no coincide, y el test se corrigió + se agregó el caso real.
- [x] **R4 🔴 Faltaba el filtro de finitud que SÍ tenía el otro use case** — un `occurredAt` ilegible producía un candidato con `executionMinutes: NaN` **con nombre y apellido** en la lista de sospechosos (`NaN >= threshold` es `false`, así que el guard no lo filtraba). Asimetría introducida POR el fix. **ARREGLADO** + test.
- [x] **R5 🔴 El 1.8 estaba a MEDIAS y figuraba cerrado** — `numOrNull` seguía con `parseFloat`: `"-34,70084"` → `-34`, **78 km de desvío sobre el dato que DECIDE el veredicto**, y `Number.isFinite` lo dejaba pasar. Se había endurecido el parser de breadcrumbs y el guard de Null Island, no el del domicilio. **ARREGLADO**: normalización de coma decimal + `Number` en vez de `parseFloat` (`"34abc"` ahora da `null`, antes daba `34`) + 4 tests.
- [x] **R6 🟡 `DISPATCH_RESET_STATUSES` partía ciclos LEGÍTIMOS** — bug introducido por el fix 1.2. Un re-despacho a la MISMA cuadrilla con la orden en curso recortaba la ventana dejando afuera viaje y llegada. **ARREGLADO**: el ciclo se abandona sólo si el despacho es para OTRA cuadrilla + 2 tests.
- [x] **R7 🟡 El test del watermark estricto estaba enmascarado** — el solapamiento de 2 h del fix 2.7 hacía que `<` y `<=` dieran idéntico resultado, y el comentario afirmaba que lo cubría. **ARREGLADO**: test con el punto JUSTO en el corte solapado.
- [x] **R8 🟡 El fix 2.10 no tenía NINGÚN test** — cero `mockRejected` en todo el archivo, y las tres rutas de rechazo SON el fix. **ARREGLADO**: 3 tests (flag, lock, release).
- [x] **R9 🟡 El fix 2.8 causaba un STALL PERMANENTE** — bug introducido. Los puntos futuros sumaban a `pointsDropped` pero no a `parsedInPage`; como el rastro es descendente, un dispositivo con el reloj adelantado llenaba la página 1 → "página ilegible" → `incomplete` para siempre → el watermark contiguo no avanzaba nunca. Se había cambiado "envenenar el watermark 10 años" por "no ingestar nunca más". **ARREGLADO**: un punto futuro SÍ cuenta como parseado (se descarta por política, no por ilegibilidad) + test.
- [ ] **R10 🟡 El SQL crudo sólo está verificado con `toContain`** — ninguna de las 1.004 suites ejecuta el `INSERT ... ON CONFLICT` ni el `DISTINCT ON` contra un Postgres real. Sin evidencia de: `gen_random_uuid()` (**cero precedentes en el repo**, todos los modelos usan `@default(uuid())` client-side; requiere PG ≥ 13 o pgcrypto), el binding de `${sources}::int[]` por adapter-pg, y `RETURNING (xmax = 0)`. Si alguno revienta, `saveMany` tira, el ingest marca TODO incompleto y queda 100% muerto con el gate verde. **ACCIÓN PRE-DEPLOY OBLIGATORIA: smoke manual contra un Postgres real (~5 min).**
- [x] **R11 🟡 Código muerto en `saveMany`** — `const rows = data.map(...)` construía N fragmentos SQL sobre todo el lote y no se usaba (el chunking recalcula el suyo). `noUnusedLocals` no está en el tsconfig, por eso tsc no lo cazaba. **ARREGLADO**.

## Lo que la re-review confirmó BIEN (verificado ejecutando)

- Modelo de ciclos (1.1/1.2) correcto, y `executionCycles.test.ts` **falla si se revierte**.
- Cota inferior `d − precisión` (1.4), precisión nullable (1.7), filtro por cuadrilla (1.9), guards de finitud (1.10), pre-filtro sin órdenes abiertas (1.11), motivo honesto (1.12): correctos y con red.
- **Ratchet roto (2.2): bien diseñado.** No hay camino por el que el watermark avance sobre un hueco — ni si `saveMany` tira, ni si `markTeamComplete` falla.
- **El bloque de seguridad (3.1→3.8) es el mejor arreglado del change**: los 8 con tests que fallan al revertir. Sin elusión del gate dinámico; `argentinaDayStart` verificado en el borde de medianoche; `respondError` con el código correcto por tipo de error.
- **Contabilidad del upsert correcta en los 4 casos**, coincide exactamente con la semántica del in-memory. **Cero inyección** (todo parametrizado). **Chunking correcto y con test.** **`DISTINCT ON`**: los nombres de columna coinciden carácter por carácter con lo que `mapRow` espera.
- **Migración puramente aditiva**: 3 `CREATE TABLE` + 5 `CREATE INDEX`, cero `ALTER` sobre tablas existentes, cero `DROP`. El índice `DESC` se generó bien.

## Nota de calibración

El caso testigo **OS 4995 sigue dando `FUERA_DE_SITIO`**, pero con exactamente 3 puntos —
el piso justo. Si alguien sube `minPointsToCondemn` a 4, el caso testigo se cae a
`NO_CONCLUYENTE` **en silencio**. Los tests dicen "16 points" y usan 3.
