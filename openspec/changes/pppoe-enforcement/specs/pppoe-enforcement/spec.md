# Capability: pppoe-enforcement

Cortes de servicio PPPoE on-demand (individuales y masivos por batch), ejecutando en la red MikroTik el estado que GR ya marcó, sin sobrecargar los maestros.

## ADDED Requirements

### Requirement: Corte individual consistente

`EnforcePppoeService` SHALL aplicar `reduce`/`block`/`restore` a un PPPoE en el router y reflejarlo en `enforcedState`, sin perder el `profile` comercial.

#### Scenario: reducir (deudor)
- **WHEN** se aplica `reduce` a un PPPoE con router alcanzable
- **THEN** el `/ppp secret` queda con el profile de reducción, la sesión activa se desconecta (kick), y `enforcedState='reduced'` — el `profile` comercial en la DB no cambia

#### Scenario: bloquear (baja)
- **WHEN** se aplica `block`
- **THEN** el secret queda `disabled=yes`, se kickea la sesión, y `enforcedState='blocked'`

#### Scenario: restaurar (pagó)
- **WHEN** se aplica `restore` a un PPPoE reducido/bloqueado
- **THEN** el secret vuelve al `profile` comercial de la DB con `disabled=no`, se kickea, y `enforcedState='active'`

#### Scenario: idempotente
- **WHEN** se aplica `reduce` a un PPPoE que ya está `reduced`
- **THEN** la operación es un no-op seguro (no falla, no duplica efecto)

#### Scenario: router caído
- **WHEN** el router no responde durante el corte
- **THEN** se devuelve `502 ROUTER_UNREACHABLE` y `enforcedState` no cambia (no miente)

### Requirement: Preview sin ejecutar

`POST /api/pppoe/enforce/preview` SHALL devolver el impacto del corte (total + desglose por router) SIN tocar ningún router ni la DB.

#### Scenario: preview de deudores
- **WHEN** se pide preview con `target='debtors'`
- **THEN** devuelve `{total, byRouter, sample}` y NO se modifica ningún secret ni `enforcedState`

### Requirement: Corte masivo on-demand por batch

`RunBulkEnforcement` SHALL procesar el batch agrupando por router, best-effort, con progreso persistido y resumible. NO se dispara automáticamente — solo on-demand.

#### Scenario: batch agrupado por router
- **WHEN** se ejecuta un bulk sobre pppoe de varios routers
- **THEN** se procesan con concurrencia limitada por router (1 carril por maestro) y varios routers en paralelo, con throttle entre operaciones

#### Scenario: un item falla, el lote sigue
- **WHEN** un router está caído durante el batch
- **THEN** ese item queda `failed` en el resultado y el resto del lote continúa (best-effort)

#### Scenario: progreso poleable
- **WHEN** se consulta `GET /api/pppoe/enforce/bulk/:jobId`
- **THEN** devuelve `status`, `total`, `doneCount`, `failedCount` y el resultado por item

#### Scenario: resumible
- **WHEN** el proceso se reinicia con un batch a medias
- **THEN** al retomar, los items ya hechos no se reprocesan (idempotencia) y los `pending` se completan

#### Scenario: no dos batches simultáneos
- **WHEN** ya hay un batch corriendo y se dispara otro
- **THEN** el segundo es rechazado (lock distribuido)

### Requirement: Control de acceso

Las rutas de enforcement SHALL exigir autenticación y el permiso `pppoe.cut`.

#### Scenario: sin permiso de corte
- **WHEN** un usuario sin `pppoe.cut` intenta cortar (individual o masivo) o pedir preview
- **THEN** responde `403`
