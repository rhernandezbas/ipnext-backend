# Proposal — gigared-tv-identity-hardening

## Intent

Cerrar los bugs de identidad de TV que destapó el incidente Centeno/Vacherand (2026-07-22). El
**root cause REAL quedó confirmado por forense (AuditEvent completo + código)** — engram
`gigared/root-cause-cic-envenenado` — y **REFUTA la teoría inicial** ("operador registró desde la
página equivocada con el nombre tipeado a mano"). NO hubo error de operador: JimenaD registró TV
para CENTENO **desde la página CORRECTA de Centeno** (la auditoría prueba que TODOS los register
del día apuntaron a `d05353e6` = Centeno). El estado partido lo produjo el CÓDIGO, de forma
automática.

### Root cause CONFIRMADO — CIC del pool envenenado por el ciclo de baja

1. **2026-07-06**: alta TV de Vacherand (201 limpio) + baja el mismo día. El `CancelTv` ejecuta
   `renewCic(internalId)` (#64, `GigaredClient.ts:403`): **el partner reasigna el internal_id del
   cliente a un CIC NUEVO** (`{oldCic, newCic}`) y lo devuelve al pool `unregistered`. El diseño
   quería limpiar ese `newCic` con `setInternalId(newCic, '')`, pero **el partner rechaza el
   internal_id vacío (#72)** → el `newCic` queda en el pool **CARGANDO el internal_id de
   Vacherand** (`ca4023a2…`), imposible de limpiar. Ese CIC envenenado ≈ `0006938875`. **El
   `newCic` NO se registra en ningún evento** → esta forense fue arqueología pura.
2. **2026-07-22**: JimenaD registra TV para CENTENO desde SU página. El register **elige un CIC AL
   AZAR del pool** `unregistered` (`RegisterGigaredAccount.ts:113-116`) **SIN comprobar si viene
   envenenado** → saca el `0006938875` con el internal_id de Vacherand adentro. `register`+`activate`
   crean la cuenta con el email determinístico correcto de Centeno (`centeno12213` = apellido
   Centeno + `grContratoId 12213` de SU contrato — todo consistente con la página correcta). La
   secuencia **falló en/antes de `setInternalId` (503 CUA)** → el `internal_id` primario quedó el de
   Vacherand (heredado del pool), sin alias de Centeno, sin vínculo local, **sin evento `alta`**.
3. Reintentos → el email determinístico ya está consumido → **"Email ya utilizado" (503) para
   siempre**. Operadores trabados. El 409 del link y el 404 del transfer iniciales son coherentes
   con `primary = Vacherand` + Vacherand cancelado. El fix del incidente fue manual (transfer-tv).

Este change endurece el código para que ese estado partido **no vuelva a ser posible** y, si
ocurre, se **auto-reconcilie**.

## Contexto — qué YA está codeado vs qué falta (no re-litigar)

- **YA está** (commits #64/#65/#72/#81/#109/#115/#118): `renewCic` en `CancelTv`;
  `deterministicTvEmail`/`deterministicTvPassword` server-side desde `grContratoId`; el guard de
  re-alta #81 (`RegisterGigaredAccount.ts:127` — `isCancelled → incrementSeq`) cableado en
  `app.ts:2506`; el CIC se auto-asigna del pool (#109, `RegisterGigaredAccount.ts:113-116`);
  persistencia de credenciales y eventos `tv_activation_events` best-effort. **NO tocamos ese
  motor.**
- **Falta el fix REAL**: (a) el register **confía ciegamente en el pool** — elige un CIC al azar y
  lo usa sin verificar que esté limpio, y no verifica que su propia identidad quedó bien estampada
  al final; (b) un fallo parcial de la secuencia partner deja la cuenta huérfana sin forma de
  completarla (reintento → 422/503 email dup); (c) `POST /register` responde SIEMPRE 201, no
  señaliza el parcial (a diferencia de link/addService que ya devuelven 207); (d)
  `ListGigaredAccounts.ts:8-13` deriva `clientId` por el alias primario del partner (append-only →
  reporta el titular VIEJO post-transfer); (e) una transferencia de TV NO deja rastro en el
  Historial TV global; (f) el evento `baja` **no registra el `newCic`** que devuelve `renewCic` →
  las minas que quedan en el pool son invisibles.

## Scope — RE-PRIORIZADO por el root cause confirmado

### CONFIRMADO — in (fixes del incidente, en orden de importancia)

1. **FIX #1 (NUEVO — la causa raíz): el register NO confía en el pool.**
   - Al elegir el CIC, **filtrar el pool**: descartar todo CIC que ya cargue un `internal_id`
     (ajeno o propio-viejo) → elegir sólo entre CICs LIMPIOS. Si **ningún** CIC del pool está
     limpio → error tipado accionable **`TV_POOL_POISONED` (422)** (familia de `NO_CIC_AVAILABLE`),
     con la cuenta de minas para el operador. **Cero writes al partner si el pool está podrido.**
   - Post-`setInternalId`, **verificar que MI identidad resuelve**:
     `getAccountByInternalId(miInternalId)` debe devolver el CIC que acabo de estampar. Si no
     (append-only mintió / stamp no tomó) → error tipado **`TV_IDENTITY_UNVERIFIED` (503)**, **sin
     fila local a medias** (el recovery del fix #2 lo levanta en el retry, idempotente).
   - **Decisión de diseño resuelta**: el listado del pool (`listAccounts({status:'unregistered'})`)
     **YA trae el `internalId` de cada cuenta** (`GigaredPort.GigaredAccount.internalId`,
     `GigaredClient.ts:146` mapea `raw.internal_id`) → **el filtrado es GRATIS, en memoria, sin
     llamadas extra** (`pool.filter(e => e.cic && !e.internalId)`). NO hace falta probe-por-elegido.

2. **FIX #2 (se mantiene): recovery idempotente + probe email-dup (ex-D2/B).** Envolver la secuencia
   partner en try/catch; probe previo `getAccountByInternalId(miInternalId)` (mine-stamped → sólo
   reconcile local, idempotente); en el catch de email-dup, discriminar por
   `listAccounts({ email })`: huérfana con `internalId` vacío → reanudar; mía → completar local;
   ajena → **`TvEmailOwnedByOtherError` (409)**. Con el fix #1, todo orphan NUEVO nace con
   `internalId` vacío (CIC limpio) → la rama "vacío → reanudar" es la correcta; la rama "ajena →
   409" cubre el orphan histórico envenenado (rehúsa auto-tocar una cuenta bindeada a otro cliente
   — la salida segura).

3. **FIX #3 (se mantiene): 207 en `POST /register`** (ex-D3, espejo link/addTvService).

4. **FIX #4 (se mantiene): lista local-first por CIC** (ex-D4). `clientId` = vínculo LOCAL por CIC
   (`ContractService.notes 'CIC {cic}'` → contract → clientId, reusando el patrón del guard 5b de
   transfer), UNA query batch; sin fila local → fallback al alias primario. Sin badge en v1.

5. **FIX #5 (se mantiene): evento `transferencia` en el Historial TV global** (ex-D7/B8 + FE badge).
   `TransferTvToCustomer` graba dos eventos `transferencia` (origen + destino), best-effort.

6. **FIX #6 (NUEVO — forense futura): el evento `baja` registra el `newCic` del `renewCic`.** Hoy
   `CancelTvJobRunner` graba `cic = result.cic` (el CIC VIEJO) pero descarta `result.renew.newCic`
   (el CIC nuevo que se envenena). Sin ese dato, cada baja deja una mina invisible. Se agrega el
   `newCic` al evento `baja` (cero migración — ver design D-baja). Es lo único que hace forense la
   próxima mina en vez de arqueología.

### DEGRADADO — hardening OPCIONAL, al final (NO fue causa del incidente)

- **Nombre no editable / BE-authoritative** (ex-Decisión A/D1): la auditoría probó **página
  correcta + nombre correcto** → el body-name NO envenenó nada en este incidente. Deja de ser fix
  principal y pasa a **hardening OPCIONAL, último batch, marcado opcional**. Se conserva la
  corrección del split **APELLIDO-primero** (verificada contra prod y contra el helper FE
  `splitName` que ya usa esa convención) dentro de ese batch. Si no entra en v1, no reabre el
  incidente (no fue causal).

### RESUELTO — la incógnita del seq/link (ex-A-VERIFICAR gated)

- **CERRADA por la auditoría**: NO hubo NINGÚN link antes del mío (el primero fue el del orquestador
  a las 16:04). El `seq=0/pelado` del incidente NO vino de un `LinkCustomerToCic` ni de un edge del
  guard #81 — vino del **CIC reciclado del cancel** (fix #1). El register de Centeno tenía `seq=0`
  **correcto** (primera alta de un cliente NO cancelado); el `internal_id` de Vacherand llegó por el
  pool, no por la lógica de seq. **Se elimina del scope** la task de verificación del seq (ex-B1) y
  su fix condicional (ex-B1b). El batch B1 pasa a ser el **fix del pool (fix #1)**.
- **Deuda documentada (NO scope)**: `LinkCustomerToCic` sigue sin replicar el guard #81 (usa
  `customer.tvActivationSeq` directo, no mintea identidad fresca en re-alta). Es un gap teórico real
  pero **no fue el incidente** → queda como **NOTA de deuda** (ver design D5-cerrado), no como task.

### OUT — fuera de alcance

- Primitiva `unlink` en el partner (NO existe; el recovery se diseña SIN ella).
- Renombrar la cuenta en el CRM del partner (sin API).
- Backfill del caso Centeno/Vacherand (ya cerrado manualmente por transfer-tv).
- Tocar `seq`/`incrementSeq` o `LinkCustomerToCic` (incógnita cerrada — no fue causal).
- **Report read-only de CICs envenenados del pool ("minas" restantes) → DEUDA CARDEADA** (no v1).
  Ver "Decisión sobre el report de minas" abajo.

## Decisión sobre el report de minas (b) — DEUDA, no v1

La (b) del root cause ("endpoint/report read-only de CICs del pool con internal_id ajeno") **NO
entra en v1**. Tradeoff corto:
- **A favor de v1**: hay MÁS minas esperando (cada baja post-#64 que no pudo limpiar dejó una); el
  filtro que las detecta **ya lo computa el fix #1** (mismo `pool.filter(e => e.internalId)`) →
  exponerlo como GET es marginalmente barato.
- **En contra (gana)**: el fix #1 **ya neutraliza el impacto operativo** (el register saltea las
  minas o corta con `TV_POOL_POISONED` — nunca las usa en silencio), así que el report es
  herramienta de limpieza/observabilidad, **no un fix de correctitud**. Y es superficie HTTP nueva
  (route + permiso + DTO + tests). Puede aterrizar como fast-follow reusando el MISMO filtro en
  memoria → **cero re-trabajo** cuando entre. **Decisión: DEUDA CARDEADA.**

## Decisiones (referencia — detalladas en design.md)

- **D-pool (NUEVO, fix #1)**: filtrado del pool en memoria + verificación post-stamp. Errores nuevos
  `TvPoolPoisonedError` (422) y `TvIdentityStampUnverifiedError` (503).
- **D2 (recovery), D3 (207), D4 (lista), D6 (`TvEmailOwnedByOtherError` 409), D7 (transferencia)**:
  se mantienen.
- **D-baja (NUEVO, fix #6)**: `newCic` en el evento `baja`.
- **D1 (nombre BE-authoritative + split APELLIDO-primero)**: DEGRADADO a hardening opcional.
- **D5 (verificación del seq)**: CERRADO — no fue causal; deuda documentada del guard de Link.
- **E — Rollout**: aditivo, sin flag. El happy path del write al partner (201, misma secuencia) no
  cambia; toda la lógica nueva es filtrado (lectura del pool ya traído), verificación (una lectura),
  recovery (catch) y señal parcial. El shape 207 es superset de 201. Rollback = revertir el change.

## Risks / flags

- **Máximo riesgo — writes reales al partner Gigared** (plata + estado real). Regla dura: **CERO
  writes reales al partner en desarrollo; todo contra fakes** (in-memory `GigaredPort`). El primer
  ejercicio en vivo lo **aprueba el usuario** explícitamente (patrón K2 SmartOLT).
- **El pool puede estar podrido HOY** (minas pre-fix): al desplegar el fix #1, un pool chico con
  todas las entradas envenenadas cortaría altas con `TV_POOL_POISONED`. Mitigación: el smoke en vivo
  mide cuántas minas hay antes de confiar; el report (deuda) o una limpieza manual las saca.
- **N+1 en la lista** (fix #4): batch obligatorio (una query).
- **207/201 observable** (fix #3): clientes del endpoint toleran 207 como éxito-parcial (ya lo hacen
  link/addService).
- **Toca `app.ts`** (wiring de la lista + transferTv) → known_debt `god-object-app`.
- **El partner miente** (append-only del internal_id): tanto el filtrado del pool como la
  verificación post-stamp comparan contra MI internalId vigente, nunca confían en el primario.
- Handlers/ramas nuevas con `next(err)`/`sendGigaredError` SIEMPRE (lección 504).

## Impacted specs

- **`gigared-customer-tv` (MODIFIED)** — Requirement `POST /api/gigared/customers/:customerId/register`:
  se reescribe alrededor del fix REAL — **anti-envenenamiento del pool** (filtrado + `TV_POOL_POISONED`)
  + **verificación post-stamp** (`TV_IDENTITY_UNVERIFIED`) + recovery idempotente + **207**. El
  scenario del body-name pasa a un requirement SEPARADO de **hardening opcional** (no causal).
- **`gigared-accounts` (MODIFIED)** — Requirement `GET /api/gigared/accounts`: `clientId` local-first
  por CIC con fallback al alias. **Sin cambios respecto de la versión anterior** (fix #4 intacto).
- **`service-transfer` (ADDED, TV-3)** — evento `transferencia` en el Historial TV global. **Sin
  cambios** (fix #5 intacto).

## Next recommended

`sdd-tasks` ya está (re-scopeado). `sdd-apply` con Strict TDD: **B1 = anti-envenenamiento del pool
(fix #1) PRIMERO**, luego recovery, 207, lista, transferencia, `newCic` en baja, y el hardening del
nombre OPCIONAL al final.
