# Portal Self-Service Specification

## Purpose

Los endpoints que la app consume para mostrar la data del cliente autenticado: saldo, facturas,
planes, tickets (ver + crear) y tareas (sus visitas). **Invariante central: toda query se ancla
al `clientId` que viene DEL TOKEN** — jamás de un param, header o body. No existe forma de pedir
data de otro cliente por construcción.

**Fuera de alcance:** pago online propio (v1 expone el `paymentUrl` existente), comentarios de
tickets de staff (internos), datos de técnicos/operación en tareas, y cualquier mutación fuera
de crear ticket.

## Requirements

### Requirement: Anclaje al cliente del token (anti-IDOR)
Todo endpoint de esta spec DEBE (MUST) resolver el cliente EXCLUSIVAMENTE del access token
(`clientId` claim). Los endpoints NO DEBEN aceptar un `clientId` por ningún otro medio; los
detalles por id (`GET /api/portal/tickets/:id`) DEBEN verificar pertenencia y responder **404**
(no 403) cuando el recurso existe pero es de otro cliente.

#### Scenario: Ticket ajeno por id
- **WHEN** un cliente autenticado pide `GET /api/portal/tickets/:id` de un ticket de OTRO cliente
- **THEN** 404 idéntico al de un id inexistente (no filtrar existencia)

### Requirement: Mi resumen (`GET /api/portal/me`)
DEBE (MUST) devolver un DTO con nombre, estado del cliente y saldo: `balances` (array por moneda)
y `lastBalanceAt`. El saldo NO sale de `Client.balanceDue` (el agregado que escribe el sync de
GR) — SIEMPRE se CALCULA sumando el `balance` de las facturas (`Invoice`, espejo local de
Prominense) del cliente que NO están pagadas (`status != 'pagada'`), agregado en la base de datos
(no trayendo todas las filas a memoria, AGRUPADO POR MONEDA). Motivo (medido en prod, HERNANDEZ
RONALD): GR puede reportar `balanceDue = 0` mientras `Invoice` tiene facturas vencidas impagas
por $100.886,90 — el cliente vería "saldo $0" arriba y facturas con botón "Pagar" abajo, una
contradicción de cara al cliente.

**Multi-moneda (fix/portal-balance-from-invoices, fix wave)** — `Invoice.currency` guarda el
código crudo de GR (medido en prod: `PES` 7430 filas, `DOL` 43 filas — NO son ISO 4217), y hay
clientes con facturas impagas en LAS DOS monedas al mismo tiempo (3 medidos en prod). Sumar todas
las monedas en un único `balance` es basura (mezcla pesos con dólares) — `balances` es un array
con **una entrada por moneda ISO 4217** (`{ currency, amount }`, normalizada vía
`normalizeGrCurrency`: `PES`→`ARS`, `DOL`→`USD`; un código desconocido se expone tal cual en
mayúsculas — nunca se asume `ARS` para una moneda que no se puede confirmar), ordenado por
`amount` DESC. **Monedas distintas JAMÁS se suman entre sí.**

`balances: [{currency, amount: 0}]` (una sola entrada) significa "al día" de verdad (el cliente
tiene facturas y todas están pagadas). `balances: null` significa "sin datos": el cliente no
tiene NINGUNA factura espejada todavía — NUNCA se colapsa a `[]` ni a `0`. `lastBalanceAt`
describe la frescura del NÚMERO mostrado (`max(createdAt)` de las facturas impagas consideradas,
de CUALQUIER moneda, o de todas si no hay impagas, o `null` sin facturas) — nunca una fecha que
no corresponda a `balances`.

#### Scenario: Cliente con deuda en una sola moneda
- **WHEN** el cliente tiene facturas con `status` `pendiente` y/o `vencida`, todas en la misma
  moneda
- **THEN** el DTO trae `balances` con UNA entrada = la suma de los `balance` de esas facturas
  (las `pagada` no suman), con la moneda ISO normalizada y `lastBalanceAt` coherentes con esas
  facturas

#### Scenario: Cliente con impagas en dos monedas
- **WHEN** el cliente tiene facturas impagas en más de una moneda (ej. `PES` y `DOL`)
- **THEN** el DTO trae `balances` con UNA ENTRADA POR MONEDA (`ARS` y `USD` respectivamente),
  cada una con la suma SOLO de sus propias facturas — JAMÁS una entrada única con la suma de
  ambas monedas mezcladas

#### Scenario: Normalización de moneda GR → ISO
- **WHEN** `Invoice.currency` trae el código crudo de GR
- **THEN** `PES` se expone como `ARS` y `DOL` como `USD`; un código que no es ninguno de los dos
  se expone tal cual en mayúsculas (nunca se asume `ARS` para una moneda que no se puede
  confirmar — asumir mentiría sobre el tipo de cambio real de esa factura)

#### Scenario: Cliente sin saldo fetcheado
- **WHEN** el cliente NO tiene ninguna factura espejada en `Invoice`
- **THEN** el DTO trae `balances: null` (sin datos, distinto de deuda cero)

#### Scenario: El saldo nunca contradice la lista de facturas
- **WHEN** se compara `balances` de `GET /api/portal/me` con la lista de
  `GET /api/portal/invoices` del mismo cliente
- **THEN** cada entrada de `balances` es EXACTAMENTE igual a la suma de los `balance`, POR
  MONEDA, de las facturas cuyo `status` no es `pagada` en esa lista — ambos endpoints leen del
  mismo dato (`Invoice`), nunca pueden mostrar números contradictorios

### Requirement: Mis facturas (`GET /api/portal/invoices`)
DEBE (MUST) listar las facturas del cliente (DTO: `number`, `issueDate`, `dueDate`, `amount`,
`balance`, `status`, `pdfUrl`, `paymentUrl`), ordenadas por `issueDate` desc, con paginado.
NUNCA la entidad Prisma cruda (`lineItems`, `grInvoiceId` y campos internos quedan fuera del
DTO de lista).

#### Scenario: Cliente consulta sus facturas
- **WHEN** un cliente con facturas pide la lista
- **THEN** ve SOLO las suyas, con su estado y links de PDF/pago cuando existen

### Requirement: Mis planes (`GET /api/portal/plans`)
DEBE (MUST) devolver los contratos del cliente con sus servicios (nombre del plan/servicio,
estado del contrato). Sin campos operativos internos.

#### Scenario: Cliente con contrato activo
- **WHEN** pide sus planes
- **THEN** ve su(s) contrato(s) con el plan contratado y estado

### Requirement: Mis tickets — ver y crear
`GET /api/portal/tickets` DEBE (MUST) listar los tickets del cliente (número, asunto, estado
como string del catálogo, fechas). `POST /api/portal/tickets` con `{subject, description}` DEBE
crear un ticket asociado al cliente del token, con estado inicial y área default definidos por
catálogo (ver design), y rate limit de creación. `GET :id` muestra el detalle SIN comentarios
internos del staff.

#### Scenario: Cliente crea un reclamo
- **WHEN** envía asunto y descripción válidos
- **THEN** el ticket queda creado, asociado a su cliente, visible al instante para los
  operadores en Prominense (misma DB, mismo `Ticket`)

#### Scenario: Payload inválido
- **WHEN** falta `subject` o `description`, o exceden los largos máximos
- **THEN** 400 con el detalle del campo

### Requirement: Mis tareas — visitas con estado público
`GET /api/portal/tasks` DEBE (MUST) listar SOLO las `ScheduledTask` del cliente, con DTO
mínimo: fecha programada, franja horaria y un **estado público** mapeado desde el stage interno
(`agendada | en_curso | completada | cancelada`). NO DEBE exponer técnico asignado, notas
internas, materiales ni el nombre crudo del stage.

#### Scenario: Cliente con visita programada
- **WHEN** tiene una instalación agendada
- **THEN** ve fecha, franja y "agendada" — nada más

#### Scenario: Stage interno sin mapeo conocido
- **WHEN** una tarea está en un stage que el mapeo no reconoce
- **THEN** se mapea al estado público más conservador (`en_curso`) — nunca se filtra el nombre interno
