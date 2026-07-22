# Delta for service-transfer

**Nota (2026-07-22)**: este requirement lo sumó el orquestador SDD durante la fase de tasks de
`gigared-tv-identity-hardening`, tras un reporte del usuario verificado en vivo contra la DB de prod
(CIC 0006938875 / Centeno, transferido ese mismo día — CERO filas en `tv_activation_events`). No
estaba en el proposal/design original de este change; se foldea acá porque extiende directamente el
contrato de `TransferTvToCustomer` (capability `service-transfer`, spec hermana en
`openspec/changes/service-transfer/specs/service-transfer/spec.md`) sin contradecir su Requirement
TV-1 — sólo agrega visibilidad en el Historial TV GLOBAL, que hoy no existía.

## ADDED Requirements

### Requirement: TV-3 — visibilidad en el Historial TV global

Una transferencia de TV exitosa (fresh o resume) MUST quedar visible en el Historial TV GLOBAL
(`GET /api/gigared/customers/activation-history`, use case `ListTvActivationHistory`, tabla
`tv_activation_events`) — hoy `TransferTvToCustomer` sólo graba en el log POR-CONTRATO
(`ContractServiceEventRepository`, transfer-out/transfer-in), que el Historial TV global NO lee.

El sistema MUST:

1. Extender `TvEventType` (`domain/ports/TvActivationEventRepository.ts`) con el valor nuevo
   `'transferencia'` (unión: `'alta' | 'baja' | 'reactivacion' | 'transferencia'`). Columna
   `TvActivationEvent.eventType` YA es `String` libre (`schema.prisma`) — **sin migración**.
2. `TransferTvToCustomer` gana una dependencia OPCIONAL nueva `activationEventRepo?:
   TvActivationEventRepository` (constructor, al final). Cuando está presente y el alias del partner
   quedó verificado (fresh o resume — Paso 2 completado en algún momento, incl. runs previos),
   registra DOS eventos `transferencia`, BEST-EFFORT (un fallo NUNCA aborta la transferencia, misma
   disciplina que el resto de los eventos de este use case):
   - uno keyed al cliente **DESTINO** (`clientId: targetCustomerId`, `internalId` = el vigente del
     destino, `contractId: targetContractId`, `reason: "Recibido por transferencia de {nombre
     origen}"`).
   - uno keyed al cliente **ORIGEN** (`clientId: sourceCustomerId`, `internalId` = el vigente del
     origen, `contractId` = el contrato origen resuelto (o `input.sourceContractId` si no hay
     resuelto), `reason: "Transferido a {nombre destino}"`) — sin este evento, el Historial TV
     por-cliente del origen queda con un corte inexplicado tras su última alta/reactivación.
   - Ambos cargan `cic`, `actorId`/`actorName` del caller. Se re-graban en modo RESUME (append-only,
     mismo criterio que los eventos por-contrato existentes).
3. `ListTvActivationHistory`/`TvActivationEventDto` MUST aceptar y devolver `'transferencia'` como
   `eventType` válido (no filtrarlo ni romper el mapeo).
4. Wiring: `app.ts` inyecta el MISMO singleton `gigaredTvActivationEventRepo` (ya instanciado para
   `RegisterGigaredAccount`/`AddTvService`) como el nuevo argumento de `TransferTvToCustomer`.

#### Scenario: Transferencia exitosa queda en el Historial TV global

- GIVEN una transferencia fresh exitosa (alias verificado, severing y reconciles OK)
- WHEN se completa `TransferTvToCustomer.execute`
- THEN `GET /api/gigared/customers/activation-history` incluye DOS eventos `eventType:
  'transferencia'` nuevos: uno con `clientId` del destino, otro con `clientId` del origen
- AND `GET /api/gigared/customers/:origen/activation-history` y `:destino/activation-history`
  muestran cada uno el evento que le corresponde

#### Scenario: Fallo al grabar el evento NUNCA aborta la transferencia

- GIVEN `activationEventRepo.record` lanza (fake que rechaza)
- WHEN se ejecuta una transferencia que de otro modo sería exitosa
- THEN la transferencia completa igual (200/207 según el resto de las condiciones), sin excepción
  propagada por el fallo del evento

#### Scenario: Resume (retry post-parcial) re-graba el evento

- GIVEN una transferencia en modo RESUME (el destino ya resolvía al mismo cic de un intento previo)
- WHEN se re-ejecuta el POST
- THEN se graban nuevamente los DOS eventos `transferencia` (append-only, rastro del retry — mismo
  criterio que los eventos transfer-out/transfer-in por-contrato)

#### Scenario: Sin `activationEventRepo` inyectado — comportamiento legacy

- GIVEN un caller que NO provee `activationEventRepo` (dependencia opcional ausente)
- WHEN se ejecuta una transferencia
- THEN el comportamiento es BYTE-IDÉNTICO al actual (sin este delta) — cero llamadas nuevas, cero
  cambio en el resultado
