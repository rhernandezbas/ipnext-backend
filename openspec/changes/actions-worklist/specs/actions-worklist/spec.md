# Spec — actions-worklist (delta)

RFC-2119. Cada scenario cubierto por al menos un test verde (sdd-verify).

## Capability: detección de casos de titularidad

### Requirement: DET-1 — el detector abre casos desde el mirror
El sistema MUST detectar contratos en baja con motivo de cambio de titularidad y abrir un
caso por contrato, sin modificar el use case del delta sync.

#### Scenario: baja con motivo titularidad y un candidato único
- Given un contrato `baja` con motivoBaja "CAMBIO DE TITULARIDAD" (ventana reciente) y UN
  contrato activo de OTRO cliente con mismo startDate y mismo address
- When corre el detector
- Then se crea un caso `pending` con source y target seteados

#### Scenario: candidatos múltiples
- Given ≥2 contratos activos que matchean las claves
- When corre el detector
- Then el caso queda `ambiguous` con la lista de candidatos y SIN target

#### Scenario: sin candidato
- Given ningún contrato activo matchea
- When corre el detector
- Then el caso se crea `pending` sin target (visible, resolvible a mano o por re-pareo DET-1b)

#### Scenario: idempotencia (casos NO prístinos)
- Given un caso ya existe para el sourceContractId Y NO es prístino (tiene target,
  candidates, review manual, o cambió de status)
- When el detector re-corre (mismo tick o siguiente)
- Then NO crea duplicado ni pisa el estado del caso existente — "caso existente no se
  toca" aplica a los NO prístinos; los prístinos se re-parean (DET-1b)

#### Scenario: motivo distinto no dispara
- Given un contrato baja con motivoBaja "MIGRACION" (u otro)
- When corre el detector
- Then NO se crea caso

#### Scenario: mismo cliente no es candidato
- Given el único contrato activo con mismas claves pertenece al MISMO cliente de la baja
- When corre el detector
- Then el caso queda sin target (un cambio de contrato del mismo cliente no es titularidad)

#### Scenario: address en blanco no parea (L5)
- Given una baja titularidad con address null O en blanco/whitespace
- When corre el detector
- Then el caso se crea `pending` sin target — un match blanco-con-blanco jamás parea

#### Scenario: cap por tick que drena (M2/B1 + fix wave 2)
- Given más bajas titularidad matcheables que el cap del batch (500), donde las primeras
  del orden estable YA tienen caso
- When corre el detector
- Then el scan EXCLUYE las bajas ya caseadas (`id NOT IN` los sourceContractIds de los
  casos existentes, cualquier status) y el batch trae las SIGUIENTES sin caso — el cap
  drena en ticks sucesivos hasta vaciar el backlog. NO hay ventana temporal: el mirror no
  puede expresarla (sin updatedAt ni fecha de baja) — la acotación es forward-only +
  exclusión de caseadas + idempotencia como cinturón intra-tick (design §2)

#### Scenario: carrera intra-tick — el cinturón de idempotencia (fix wave 2)
- Given un caso para una baja del batch se crea ENTRE el snapshot de ids caseados y el
  procesamiento de esa baja (carrera dentro del tick)
- When el detector procesa esa baja
- Then el guard `existsBySourceContract` la cuenta como skipped sin crear duplicado ni
  abortar el batch

#### Scenario: un fallo per-baja no aborta el batch (M2)
- Given una baja cuyo create falla (P2002 por carrera u otro error)
- When corre el detector
- Then esa baja cuenta como skipped y las DEMÁS bajas del batch se procesan igual

#### Scenario: el detector nunca tumba el scheduler
- Given el repo de casos lanza
- When corre el tick del scheduler
- Then el error se traga con log y las demás patas del sync corren igual

### Requirement: DET-1b — re-pareo de casos prístinos (H1a)
El detector MUST re-parear en cada tick los casos PRÍSTINOS — `pending`, sin target, sin
candidates y con `equipmentReviewed=false` (nada manual pasó) — contra el mirror actual.
Cierra el dead-end del timing F0 (baja y alta entran al mirror en ticks distintos).

#### Scenario: prístino gana target cuando aparece el candidato
- Given un caso prístino (la baja llegó sola en el tick anterior) y ahora UN contrato
  activo de otro cliente matchea las claves
- When corre el detector
- Then el caso queda `pending` con target seteado (repaired++)

#### Scenario: prístino pasa a ambiguous con múltiples candidatos
- Given un caso prístino y ahora ≥2 contratos matchean
- When corre el detector
- Then el caso pasa a `ambiguous` con la lista de candidatos y sin target

#### Scenario: caso NO prístino jamás se re-parea
- Given un caso con review manual (o con target, o con candidates, o no-pending)
- When corre el detector
- Then el caso NO se toca aunque haya candidatos nuevos en el mirror

#### Scenario: origen fuera del mirror no rompe el batch
- Given un caso prístino cuyo sourceContractId ya no existe en el mirror
- When corre el detector
- Then ese caso se salta sin error y el resto del batch se procesa

#### Scenario: el re-pareo es un CAS — no resucita ni pisa (fix wave 2)
- Given un caso listado como prístino que un operador DESCARTÓ (o al que le seteó target)
  por HTTP ENTRE el listado de prístinos y el write del re-pareo (carrera detector-vs-HTTP)
- When el detector intenta re-parearlo
- Then el write condicional (`updateIfPristine`, WHERE = shape prístino completo) no
  matchea → el caso queda EXACTAMENTE como lo dejó el operador (dismissed con su
  dismissReason intacto / target manual intacto) y NO cuenta como repaired

## Capability: worklist de casos con checks

### Requirement: CASE-1 — checks AUTO computados contra el estado real
El listado MUST computar los checks en la lectura, nunca persistirlos como verdad.
Semántica H2: `null` = "no evaluable O no aplica" (el FE muestra "—") y los null NUNCA
bloquean el flip a done.

#### Scenario: TV transferida
- Given el titular viejo tiene tvCancelledAt seteado Y el contrato destino tiene fila TV
  managed activa
- When se listan los casos
- Then el check tv es OK

#### Scenario: TV pendiente (hay TV que transferir)
- Given el origen tiene fila TV managed ACTIVA aún sin severed, O el titular viejo está
  severed pero el destino no tiene fila TV activa
- Then el check tv es pendiente

#### Scenario: cliente sin TV — el check no aplica (H2)
- Given el titular viejo NO está severed Y el contrato origen NO tiene fila TV managed
  activa (nunca tuvo TV, o la fila está inactiva)
- Then el check tv es null (no aplica — no hay nada que transferir) y NO bloquea el done

#### Scenario: sin catálogo TV
- Given no existe el catálogo de servicio "TV"
- Then el check tv es null y NO bloquea el done

#### Scenario: checks sin target
- Given un caso sin targetContractId
- Then los checks tv y pppoe son no-evaluables (null) — el FE muestra "—"

#### Scenario: PPPoE migrado
- Given el contrato origen tiene (o tuvo) PppoeService Y existe un PppoeService enabled
  con contractId = target
- Then el check pppoe es OK

#### Scenario: cliente TV-only — pppoe no aplica (H2)
- Given el contrato ORIGEN no tiene NINGÚN PppoeService (nada que migrar)
- Then el check pppoe es null y NO bloquea el done

#### Scenario: flip a done (H2 — los n/a no bloquean)
- Given un caso pending con equipmentReviewed=true Y tv !== 'pending' Y pppoe !== 'pending'
  (ok o null indistinto)
- When se lista
- Then el caso pasa a done (persistido vía CAS) y deja de contar como pendiente

#### Scenario: flip con ambos checks n/a (caso solo-equipos)
- Given un caso pending con tv=null y pppoe=null (cliente sin TV y sin PPPoE) y
  equipmentReviewed=true
- When se lista
- Then el caso flipea a done — el review de equipos era lo único aplicable

#### Scenario: el flip es un CAS — un dismiss concurrente no se pisa (M1)
- Given el caso califica para el flip pero OTRO request lo descartó entre la lectura y el
  flip (TOCTOU)
- When flipToDone devuelve false (el WHERE condicional {id, pending, reviewed} no matcheó)
- Then el DTO NO sale done — sale el estado real releído (dismissed) y el descarte se respeta

#### Scenario: flip best-effort ante fallo de infraestructura
- Given flipToDone LANZA (DB caída)
- When se lista
- Then el DTO sale done igual, el error se traga y el flip se re-intenta en la próxima lectura

### Requirement: CASE-2 — mutaciones del caso con rastro
`PATCH /ownership-cases/:id` MUST soportar: check manual con actor/fecha, pick de candidato
validado, RE-pick (H1c), SET-target validado contra el mirror (H1b), descarte con motivo
obligatorio y reapertura que limpia el target heredado (H1d); todo gateado por
`actions:manage`.

#### Scenario: check manual de equipos
- When PATCH {equipmentReviewed:true} con usuario autorizado sobre un caso pending o ambiguous
- Then el caso guarda reviewed + actorId + fecha

#### Scenario: check manual solo sobre casos abiertos (L2)
- Given un caso done o dismissed
- When PATCH {equipmentReviewed:true|false}
- Then 422 INVALID_CASE_TRANSITION sin efectos

#### Scenario: pick de candidato
- Given un caso ambiguous con candidatos [A, B]
- When PATCH {targetContractId: A}
- Then el caso pasa a pending con target A
- And un PATCH con un contractId que NO está en candidates MUST fallar 422 sin efectos

#### Scenario: re-pick corrige la elección errada (H1c)
- Given un caso pending CON target A y candidates [A, B] persistidos (pick previo)
- When PATCH {targetContractId: B}
- Then el caso queda pending con target B (membership en candidates, como el pick original)
- And un contractId fuera de candidates MUST fallar 422 sin efectos

#### Scenario: set-target sobre el pending sin target (H1b — caso 0-candidatos)
- Given un caso pending con targetContractId=null y candidates=null (el detector no encontró
  candidato y el re-pareo tampoco)
- When PATCH {targetContractId: X} donde X existe en el mirror, NO está en baja y pertenece
  a un cliente distinto de sourceClientId
- Then el caso queda pending con target X (validado contra el mirror)

#### Scenario: set-target inválido → 422 sin efectos (H1b)
- Given el mismo caso pending sin target
- When PATCH {targetContractId: X} donde X no existe en el mirror, O está en baja, O
  pertenece al MISMO cliente de la baja
- Then 422 INVALID_TARGET_ASSIGNMENT sin efectos

#### Scenario: descarte
- When PATCH {status:'dismissed'} sin reason
- Then 400 sin efectos; con reason el caso queda dismissed

#### Scenario: done no se descarta (L3)
- Given un caso done
- When PATCH {status:'dismissed', reason}
- Then 422 INVALID_CASE_TRANSITION sin efectos (done es un cierre exitoso)

#### Scenario: reopen limpia el target heredado (H1d)
- Given un caso dismissed con candidates !== null Y target seteado (heredado de un pick previo)
- When PATCH {status:'pending'}
- Then el caso vuelve a `ambiguous` con targetContractId/targetClientId LIMPIOS (null) y
  candidates intactos — el pick posiblemente errado no sobrevive al reopen

#### Scenario: sin permiso
- Given usuario sin actions:manage
- When PATCH
- Then 403 sin efectos (y GET sin actions:read → 403)

## Capability: bajas recientes

### Requirement: BAJA-1 — listado computado con check de retiro
El listado MUST derivarse del mirror (sin tabla propia) y computar el check "orden de
retiro". "Reciente" = motivoBaja NOT NULL (proxy forward-only — M3, design §4); NO existe
parámetro `days=` (no implementable sin updatedAt/fecha de baja en el mirror).

#### Scenario: baja con orden de retiro
- Given un contrato baja reciente con una ScheduledTask de un proyecto con
  allowsEquipmentRetirement=true que referencia ESE contrato, o al cliente con
  task.contractId=null
- Then la fila muestra retirementOrder.exists=true con el taskId

#### Scenario: task de retiro de OTRO contrato no cuenta (M4)
- Given una ScheduledTask de retiro del MISMO cliente pero linkeada a OTRO contrato
- Then la fila de esta baja muestra exists=false — sin falsos positivos por cliente

#### Scenario: baja sin orden y con equipos
- Given un contrato baja sin task de retiro y con ítems de inventario activos
- Then la fila lo muestra (exists=false + conteo de equipos) — la alarma operativa

#### Scenario: titularidad excluida
- Given un contrato baja con motivo CAMBIO DE TITULARIDAD
- Then NO aparece en bajas recientes (vive en el tab de titularidad)

#### Scenario: baja histórica del backfill excluida (M3)
- Given un contrato baja con motivoBaja NULL (sincronizado antes del rollout forward-only
  de 2026-07-10)
- Then NO aparece en bajas recientes — el listado es honesto sobre "reciente"

## Capability: RBAC y robustez

### Requirement: RBAC-1 — módulo actions doble capa
Las rutas MUST estar gateadas por actions:read/actions:manage; migración seed idempotente
(módulo + permisos + grants super_admin/administrador).

#### Scenario: seed idempotente
- When la migración corre dos veces
- Then no falla ni duplica filas

### Requirement: ROB-1 — no cuelga (lección 504)
Handlers async MUST responder inmediato ante errores (next(err) / mapeo por instancia).

#### Scenario: repo lanza
- When un repo lanza en GET/PATCH
- Then responde status inmediato, nunca cuelga
