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
DEBE (MUST) devolver un DTO con nombre, estado del cliente y saldo: `balanceDue`,
`balanceCurrency` y `lastBalanceAt` del espejo local. `balanceDue = null` (sin fetch de GR aún)
se expone como `balance: null` — la app lo muestra como "sin datos", NUNCA como $0.

#### Scenario: Cliente sin saldo fetcheado
- **WHEN** `balanceDue` es null en el espejo
- **THEN** el DTO trae `balance: null` (distinto de deuda cero)

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
