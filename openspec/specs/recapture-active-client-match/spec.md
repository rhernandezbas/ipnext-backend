# recapture-active-client-match Specification

## Purpose

Detección **informativa** de "posible cliente activo" sobre leads de Recaptación: 4 señales (contacto por teléfono/email, re-alta, motivo de baja) que se muestran como badge en la tabla y detalle enriquecido en el drawer. NUNCA muta el lead (efecto de listado/detalle). Riding sobre `GET /api/recapture/leads` y `GET /api/recapture/leads/:id`, ambos ya gateados por `recapture.read` — sin permiso nuevo.

La señal (d) "motivo de baja = titularidad" NO es CSV-only: este change **persiste** el `motivo_baja` de GR en `Contract.motivoBaja` (migración aditiva) y computa (d) en tiempo de match desde `lead.churnReason` (CSV/ingest) **y** el motivo persistido del contrato del cliente. Es **forward-only** (sin backfill histórico de GR): la cobertura de (d) para bajas antiguas crece con el tiempo.

## Contract (DTOs)

```
RecaptureLeadListItemDto.possibleActiveMatchSignals: Array<'phone'|'email'|'reactivated'|'churn_reason'>
  // [] = sin match. Unión deduplicada de señales disparadas por CUALQUIER cliente matcheado.

RecaptureLeadDetailDto.possibleActiveMatch: {
  signals: Array<'phone'|'email'|'reactivated'|'churn_reason'>,
  matchedClients: Array<{ clientId: string, name: string, status: CustomerStatus,
                           matchedBy: Array<'phone'|'email'|'reactivated'> }>
}
  // 'churn_reason' vive en `signals` pero NO cuelga de ningún matchedClients[i]
  // (es una propiedad del lead mismo, no de un cliente).
```

## Requirements

### Requirement: Enriquecimiento batch en el listado
El sistema MUST calcular `possibleActiveMatchSignals` para cada lead de la página actual mediante UNA operación batch acotada al tamaño de página (≤ límite de paginación), sin N+1 (costo no MUST crecer por lead). El mecanismo concreto (query OR de Prisma, candidate-set en memoria, u otro) queda abierto a design — este requerimiento es sobre el resultado observable, no sobre la forma de la query.

#### Scenario: Lead sin ningún match
- GIVEN un lead cuyo contacto/cliente no matchea ninguna señal
- WHEN se pide `GET /api/recapture/leads`
- THEN `possibleActiveMatchSignals` es `[]` para ese lead

#### Scenario: Página sin leads
- GIVEN una query cuyo filtro no devuelve leads
- WHEN se pide `GET /api/recapture/leads`
- THEN la respuesta es `200` con `data: []` y NO se ejecuta ninguna operación de matching

### Requirement: Señal de teléfono — normalización y sufijo
El sistema MUST normalizar el teléfono del lead y el del cliente candidato (quitar todo carácter no-dígito, y los artefactos `+54`, `0` inicial, `9` inicial, `15` insertado) y comparar los últimos 8 dígitos. Números equivalentes escritos con distinta convención MUST normalizar al mismo sufijo.

#### Scenario: Formatos equivalentes con +54/0/9/15/guiones
- GIVEN `lead.phone = "+54 9 11 1234-5678"` y `client.phone = "011 15-1234-5678"` (mismo cliente)
- WHEN se computa la señal de teléfono
- THEN ambos normalizan al mismo sufijo de 8 dígitos y la señal `'phone'` se dispara

### Requirement: Señal de email — comparación exacta normalizada
El sistema MUST comparar `email` del lead y del cliente candidato tras aplicar `lowercase` + `trim` a ambos lados; MUST ser un match exacto post-normalización (no substring, no dominio).

#### Scenario: Email con mayúsculas y espacios
- GIVEN `lead.email = " Juan@Mail.com "` y `client.email = "juan@mail.com"`
- WHEN se computa la señal de email
- THEN la señal `'email'` se dispara

### Requirement: Robustez ante datos de contacto ausentes o inválidos
El sistema MUST NUNCA lanzar excepción por datos de contacto faltantes o inválidos, y MUST tratarlos como "sin match" para esa señal.

#### Scenario: Teléfono corto o basura
- GIVEN `lead.phone = "123"` o `lead.phone = "n/a"` (menos de 8 dígitos tras normalizar)
- WHEN se computa la señal de teléfono
- THEN NO se dispara `'phone'` y la operación NO lanza excepción

#### Scenario: Teléfono o email null/vacío en cualquiera de los dos lados
- GIVEN `lead.phone = null` (o `client.email = ""`)
- WHEN se computan las señales de contacto
- THEN esa señal específica NO se dispara para ese lado, sin excepción, y las demás señales se evalúan normalmente

### Requirement: Exclusión del propio cliente en señales de contacto
Las señales de teléfono y email MUST excluir al cliente igual a `lead.clientId` — ese caso lo cubre exclusivamente la señal de re-alta.

#### Scenario: El propio cliente del lead no cuenta como match de contacto
- GIVEN un lead con `clientId = "c1"` y `client c1` con el mismo phone/email que el lead
- WHEN se computan las señales de contacto
- THEN `c1` NO aparece en `matchedClients` vía `'phone'`/`'email'` (puede aparecer vía `'reactivated'` si aplica)

### Requirement: Señal de re-alta (reactivated)
El sistema MUST disparar `'reactivated'` ÚNICAMENTE cuando `lead.clientId` no es null y el `Client` referenciado por ese id tiene `status = 'active'`. Ningún otro cliente puede disparar esta señal.

#### Scenario: El propio cliente del lead volvió a estar activo
- GIVEN un lead con `clientId = "c1"` y `client c1.status = 'active'`
- WHEN se computan las señales
- THEN `'reactivated'` se dispara y `c1` aparece en `matchedClients` con `matchedBy` incluyendo `'reactivated'`

#### Scenario: Cliente distinto activo no dispara re-alta
- GIVEN un lead con `clientId = "c1"` (no active) y un cliente distinto `c2` activo que matchea por teléfono
- WHEN se computan las señales
- THEN `'reactivated'` NO se dispara; `c2` aparece solo con `matchedBy: ['phone']`

### Requirement: Señal de motivo de baja ("titularidad") — desde ambas fuentes
El sistema MUST disparar `'churn_reason'` cuando el motivo de baja del lead menciona "titularidad" (subcadena case-insensitive). El motivo se evalúa sobre un conjunto **source-agnostic** de textos (`churnReasonTexts: string[]`) que el caller arma desde AMBAS fuentes: `lead.churnReason` (poblado por el import CSV Y por `IngestChurnedClients`) **y** el `motivoBaja` persistido del contrato del propio cliente del lead (`lead.clientId`). El helper puro sólo ve el `string[]` y no conoce la fuente. **Limitación conocida (forward-only)**: `Contract.motivoBaja` se puebla SÓLO desde los syncs de GR futuros (sin backfill histórico), por lo que la cobertura de esta señal para bajas antiguas crece con el tiempo, a medida que sus contratos se re-espejan. Esto NO es una falla de escenario: es el alcance aceptado de este change.

#### Scenario: Motivo de titularidad (cualquiera de las dos fuentes)
- GIVEN un lead cuyo conjunto `churnReasonTexts` contiene "CAMBIO DE TITULARIDAD" (venga de `lead.churnReason` del CSV o del `motivoBaja` del contrato)
- WHEN se computan las señales
- THEN `'churn_reason'` se dispara (independientemente de si hay `matchedClients`)

#### Scenario: Sin motivo de titularidad en ninguna fuente
- GIVEN un lead cuyo `lead.churnReason` es null Y el contrato de su cliente no tiene `motivoBaja` con "titularidad" (o ambos ausentes)
- WHEN se computan las señales
- THEN `'churn_reason'` NO se dispara, sin excepción

#### Scenario: churned_client dispara (d) por el contrato, sin churnReason propio
- GIVEN un lead `source = 'churned_client'` con `churnReason = null` cuyo cliente tiene un contrato con `motivoBaja = "CAMBIO DE TITULARIDAD"`
- WHEN se pide `GET /api/recapture/leads` o `/:id`
- THEN `'churn_reason'` aparece en las señales del lead (leído del contrato en tiempo de match, sin backfill de leads)

### Requirement: Persistencia de `motivo_baja` desde el delta de contratos de GR
El delta sync de contratos (`SyncGestionRealContractsDelta`, vía `ClientMirrorRepository.upsertContract`) MUST persistir el `motivo_baja` que trae el feed `contratos` de GR en el campo mirror `Contract.motivoBaja`. Es GR-owned (GR gana en cada sync, igual que `vendedor`), nullable y aditivo; el cuerpo de `execute()` NO cambia (ya forwarda el `GrContract` completo). El parseo de `motivo_baja` MUST ocurrir en los parsers del feed `contratos` (delta y per-cliente).

#### Scenario: Contrato del delta con motivo_baja
- GIVEN el feed `contratos` de GR devuelve un contrato con `motivo_baja = "CAMBIO DE TITULARIDAD"`
- WHEN `upsertContract` lo espeja (create o update)
- THEN `Contract.motivoBaja` queda persistido con ese valor

#### Scenario: Contrato sin motivo_baja no rompe
- GIVEN el feed devuelve un contrato Vigente sin `motivo_baja`
- WHEN `upsertContract` lo espeja
- THEN `Contract.motivoBaja` queda `null`, sin excepción (GR-owned)

### Requirement: Poblado de `churnReason` al ingerir churned clients
`IngestChurnedClients` MUST estampar `RecaptureLead.churnReason` desde el `motivoBaja` persistido del contrato de baja del cliente, al CREAR el lead `churned_client`. Como el ingest es create-only/idempotente, MUST NOT re-estampar `churnReason` en leads ya existentes (la cobertura de esos leads viejos la aporta la lectura del contrato en tiempo de match, sin backfill de leads).

#### Scenario: Lead nuevo hereda el motivo del contrato
- GIVEN un cliente `status = 'baja'` sin lead previo, cuyo contrato tiene `motivoBaja = "CAMBIO DE TITULARIDAD"`
- WHEN corre `IngestChurnedClients`
- THEN el nuevo `RecaptureLead` (`source = 'churned_client'`) nace con `churnReason = "CAMBIO DE TITULARIDAD"`

#### Scenario: Ingest idempotente no re-estampa (forward-only)
- GIVEN un cliente baja que YA tiene un lead `churned_client` (creado antes, `churnReason = null`), y su contrato ahora tiene `motivoBaja`
- WHEN corre `IngestChurnedClients` otra vez
- THEN el lead existente NO se modifica (su `churnReason` sigue null); la señal (d) para ese lead se resuelve leyendo el contrato en tiempo de match

### Requirement: Cardinalidad de múltiples clientes matcheados
El sistema MUST reportar TODOS los clientes activos que matcheen (deduplicados por `clientId`) en `matchedClients`; no se impone un tope artificial. `possibleActiveMatchSignals` en el listado MUST ser la unión deduplicada de las señales de todos los matches, sin importar cuántos clientes las originaron.

#### Scenario: Dos clientes activos matchean el mismo lead
- GIVEN un lead cuyo teléfono matchea a los clientes activos `c2` y `c3` (ninguno es `lead.clientId`)
- WHEN se pide el detalle del lead
- THEN `matchedClients` contiene ambos, cada uno con su propio `matchedBy`
- AND en el listado, `possibleActiveMatchSignals` contiene `'phone'` una sola vez (no duplicado)

### Requirement: Detalle enriquecido en GET single lead
`GET /api/recapture/leads/:id` MUST incluir `possibleActiveMatch` con `signals` y `matchedClients` (id/name/status/matchedBy) suficientes para que el FE abra `ContractHistoryModal` para cualquier cliente matcheado, vía `GetRecaptureLead` (gana dependencia de `CustomerRepository`).

#### Scenario: Detalle sin ningún match
- GIVEN un lead sin matches de ningún tipo
- WHEN se pide `GET /api/recapture/leads/:id`
- THEN `possibleActiveMatch = { signals: [], matchedClients: [] }` (nunca `undefined`)

#### Scenario: churn_reason sin cliente matcheado
- GIVEN un lead CSV con `churnReason` mencionando "titularidad" pero sin match de contacto ni re-alta
- WHEN se pide el detalle
- THEN `signals` incluye `'churn_reason'` y `matchedClients` es `[]` (la señal es válida sin cliente asociado)

### Requirement: Comportamiento informativo — cero mutación
El sistema MUST NOT modificar el `RecaptureLead` (ni ningún `Client`) como efecto de calcular o exponer estas señales, en list ni en detail.

#### Scenario: Consultar el detalle no cambia nada
- GIVEN un lead con matches
- WHEN se pide `GET /api/recapture/leads/:id` repetidamente
- THEN `updatedAt` del lead y el estado de los clientes matcheados no cambian por este efecto

### Requirement: Permisos — sin permiso nuevo
Las señales MUST exponerse bajo los guards ya existentes de `recapture.read` (incluida la restricción server-side por actor de `recapture-assign`); no se introduce ningún permission code nuevo.

#### Scenario: Sin `recapture.read` no hay acceso
- GIVEN un actor sin `recapture.read`
- WHEN pide `GET /api/recapture/leads` o `/:id`
- THEN la respuesta es `403`, igual que hoy sin este feature

### Requirement (FE): Badge en la tabla de Recaptación
`RecaptacionTableView` MUST renderizar un indicador visible cuando `possibleActiveMatchSignals.length >= 1`, y MUST NOT renderizar nada cuando está vacío. Agregar este indicador MUST NOT alterar el render de las columnas existentes (`technologies`, `status`).

#### Scenario: Badge visible y ausente
- GIVEN una fila con `possibleActiveMatchSignals: ['phone']` y otra con `[]`
- WHEN se renderiza la tabla
- THEN la primera fila muestra el indicador y la segunda no
- AND los badges de tecnología y el pill de estado se renderizan igual que antes en ambas filas

### Requirement (FE): Sección de match en el drawer
`LeadDetailDrawer` MUST renderizar una sección de match cuando `possibleActiveMatch.signals.length >= 1`, mostrando cada `matchedClients[i]` (name/status/señales) con una acción para abrir `ContractHistoryModal` con `clientId = matchedClients[i].clientId`. MUST NOT renderizar la sección cuando `signals` está vacío.

#### Scenario: Drawer con match de contacto
- GIVEN el detalle trae `matchedClients: [{ clientId: "c2", name: "Ana", status: "active", matchedBy: ["phone"] }]`
- WHEN se abre el drawer
- THEN se muestra "Ana" con su estado y un botón que abre `ContractHistoryModal` para `c2` (no para `view.clientId` del lead)

#### Scenario: Drawer con churn_reason sin cliente
- GIVEN el detalle trae `signals: ['churn_reason']`, `matchedClients: []`
- WHEN se abre el drawer
- THEN la sección se renderiza mostrando el flag de motivo de baja, sin botón de contratos (no hay cliente asociado)
