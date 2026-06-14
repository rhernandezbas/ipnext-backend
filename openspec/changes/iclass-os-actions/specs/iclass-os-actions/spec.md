# Spec — IClass OS Actions

> Capability: `iclass-os-actions` (delta). Operar la OS de IClass desde Prominense: cerrar/validar (Fase 2) y asignar cuadrilla (Fase 3).

## ADDED Requirements

### Requirement: Cerrar/validar la OS desde Prominense

El sistema DEBE permitir cerrar una Orden de Servicio de IClass desde Prominense, empujando `POST /serviceorders/close` con un result-code del catálogo, un comentario y una fecha de cierre, sujeto a un pre-check de precondiciones y a un feature flag de runtime.

#### Scenario: Cierre exitoso con pre-check verde
- **GIVEN** una tarea con `iclassOrderCode` no nulo y `generalStatus === 'open'`
- **AND** el flag `iclass-close-action` está habilitado
- **AND** el `resultCode` existe en el catálogo `IClassResultCode`
- **AND** la OS en IClass NO está en estado terminal (`statusCode !== '7'`)
- **WHEN** un usuario con permiso `scheduling.iclass_close` cierra la OS
- **THEN** el sistema llama `closeServiceOrder` con `{ serviceOrderCode, resultCode, closeDate, commentary }`
- **AND** marca la tarea `generalStatus = 'closed'`
- **AND** registra una actividad `status_changed`

#### Scenario: Pre-check detecta OS ya cerrada en IClass
- **GIVEN** una tarea `open` cuya OS en IClass ya está en estado terminal (`statusCode === '7'`, el técnico cerró en campo)
- **WHEN** se intenta cerrar la OS desde Prominense
- **THEN** el sistema NO llama `closeServiceOrder`
- **AND** responde 409 `ICLASS_ALREADY_CLOSED`

#### Scenario: Acción deshabilitada por feature flag
- **GIVEN** el flag `iclass-close-action` está deshabilitado (default OFF)
- **WHEN** un usuario con el permiso intenta cerrar la OS
- **THEN** el sistema NO llama a IClass
- **AND** responde 409 `ICLASS_ACTION_DISABLED`

#### Scenario: Tarea no abierta
- **GIVEN** una tarea con `generalStatus !== 'open'` (closed/dismissed)
- **WHEN** se intenta cerrar la OS
- **THEN** el sistema responde 409 `ICLASS_TASK_NOT_OPEN` sin tocar IClass

#### Scenario: Tarea sin OS en IClass
- **GIVEN** una tarea con `iclassOrderCode` nulo
- **WHEN** se intenta cerrar la OS
- **THEN** el sistema responde 422 `ICLASS_NO_SERVICE_ORDER`

#### Scenario: IClass rechaza el cierre con detalle visible
- **GIVEN** una tarea cerrable
- **WHEN** IClass responde con `erros` (rechazo de negocio)
- **THEN** el sistema responde 422 `ICLASS_REJECTED`
- **AND** el cuerpo incluye `reason` con el `code: description` que devolvió IClass
- **AND** la tarea NO se marca cerrada localmente

#### Scenario: IClass no disponible
- **GIVEN** una tarea cerrable
- **WHEN** IClass devuelve 5xx, timeout o falla de auth persistente
- **THEN** el sistema responde 502 `ICLASS_UNAVAILABLE`
- **AND** la tarea NO se marca cerrada localmente

### Requirement: Asignar la cuadrilla/técnico desde Prominense

El sistema DEBE permitir asignar una cuadrilla (team) de IClass a una OS desde Prominense, empujando `POST /serviceorders/update` con el campo `requiredTeam`, sujeto al mismo pre-check de precondiciones y a un feature flag de runtime.

#### Scenario: Asignación exitosa
- **GIVEN** una tarea `open` con OS no terminal en IClass
- **AND** el flag `iclass-assign-action` habilitado
- **AND** un `teamLogin` que existe en el catálogo `IClassTeam` y es `active && selectable`
- **WHEN** un usuario con permiso `scheduling.iclass_assign` asigna la cuadrilla
- **THEN** el sistema llama `updateServiceOrder` con `{ serviceOrderCode, requiredTeam }`
- **AND** registra una actividad de asignación

#### Scenario: Cuadrilla no asignable
- **GIVEN** un `teamLogin` inexistente, inactivo o no seleccionable
- **WHEN** se intenta asignar
- **THEN** el sistema responde 422 `ICLASS_TEAM_NOT_ASSIGNABLE` sin tocar IClass

#### Scenario: Asignación deshabilitada por flag
- **GIVEN** el flag `iclass-assign-action` deshabilitado (default OFF)
- **WHEN** se intenta asignar
- **THEN** el sistema responde 409 `ICLASS_ACTION_DISABLED`

### Requirement: Catálogo de cuadrillas IClass sincronizable

El sistema DEBE sincronizar el catálogo de cuadrillas (teams) desde `GET /teams`, mismo patrón que el catálogo de nodos: upsert por `login`, marcado de inactivos ausentes, y flag `selectable` para agrupadores.

#### Scenario: Sincronización upsert por login
- **GIVEN** IClass devuelve una lista de teams
- **WHEN** corre `SyncIClassTeams`
- **THEN** cada team se upserta por `login` (clave estable)
- **AND** los teams con `login` vacío se descartan
- **AND** los teams ausentes de la respuesta se marcan `active = false`

#### Scenario: Reactivación de team
- **GIVEN** un team previamente `active = false`
- **WHEN** vuelve a aparecer en la respuesta de IClass
- **THEN** se reactiva (`active = true`) y se cuenta como `reactivated`

#### Scenario: Listado para el selector
- **GIVEN** teams sincronizados
- **WHEN** el FE pide el catálogo con gate `iclass.read`
- **THEN** recibe los teams con `{ login, name, thirdPartyCode, active, selectable }`

### Requirement: Pre-check de estado de OS en vivo

El sistema DEBE consultar el estado actual de la OS en IClass en vivo (`GET /serviceorders/{id}`) antes de toda acción de escritura (cierre o asignación), porque el estado cacheado en la tarea (`iclassStatusCode`, Fase 1) puede tener hasta 10 minutos de lag y el cierre es destructivo.

#### Scenario: Snapshot en vivo
- **WHEN** se ejecuta una acción de cierre o asignación
- **THEN** el sistema llama `getServiceOrder(orderCode)` para obtener el estado actual
- **AND** usa ese estado (no el cache) para decidir si la OS ya está cerrada

#### Scenario: OS desconocida por IClass
- **GIVEN** una tarea con `iclassOrderCode` que IClass no reconoce (404)
- **WHEN** el pre-check consulta `getServiceOrder`
- **THEN** devuelve null y el sistema responde 422 `ICLASS_NO_SERVICE_ORDER`

### Requirement: Resiliencia ante el riesgo de escritura no probada

Como `close`, `update`, `getServiceOrder` y `teams` nunca se ejercitaron contra la API real de IClass (que ya divergió de su doc 3 veces), el sistema DEBE traducir toda respuesta a errores de dominio con detalle visible, pasar toda escritura por `withAuthRetry`, y arrancar cada acción detrás de un feature flag OFF por default.

#### Scenario: Reintento ante rate-limit 429
- **GIVEN** IClass devuelve HTTP 429 en una escritura
- **WHEN** el adapter ejecuta la llamada vía `withAuthRetry`
- **THEN** reintenta con backoff exponencial (hasta 4 intentos) antes de propagar `IClassUnavailableError`

#### Scenario: Respuesta inesperada no se trata como éxito
- **GIVEN** IClass devuelve un body que no contiene el indicador de éxito esperado
- **WHEN** el adapter parsea la respuesta de `closeServiceOrder`
- **THEN** lanza `IClassUnavailableError` con mensaje explícito (nunca un success silencioso)

#### Scenario: Acciones inertes hasta validación en vivo
- **GIVEN** un deploy nuevo con ambos flags OFF
- **WHEN** cualquier usuario (incluido super_admin) intenta una acción
- **THEN** el sistema responde 409 `ICLASS_ACTION_DISABLED` hasta que el operador habilite el flag tras la prueba en vivo controlada
