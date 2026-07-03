# Spec — internet-history-plan-direction

## ADDED Requirement: Dirección derivada del cambio de plan
El sistema DEBE derivar (NO persistir) la dirección de un cambio de plan comparando el `downloadKbps` del plan nuevo vs el viejo contra el catálogo de planes, y exponerla como `direction: 'upgrade' | 'downgrade' | null` en cada `InternetServiceEventDto`.

### Scenario: Upgrade
- **GIVEN** un evento `modified` con `oldPlan=IP-30M` (30000 kbps) y `newPlan=IP-50M` (50000 kbps)
- **WHEN** se lista el historial de internet
- **THEN** el DTO tiene `direction='upgrade'`, `oldPlan='IP-30M'`, `newPlan='IP-50M'`

### Scenario: Downgrade
- **GIVEN** un evento `modified` con `oldPlan=IP-100M` (100000) y `newPlan=IP-50M` (50000)
- **THEN** `direction='downgrade'`

### Scenario: Cambio lateral (kbps iguales) → null
- **GIVEN** un `modified` cuyos dos planes tienen el mismo `downloadKbps`
- **THEN** `direction=null`

### Scenario: Plan de enforcement → null
- **GIVEN** un `modified` donde `oldPlan` o `newPlan` es `IP-REDUCCION` o `IP-BAJA`
- **THEN** `direction=null` (es corte/reducción, no un cambio comercial)

### Scenario: Código fuera del catálogo → null
- **GIVEN** un `modified` con un código de plan que no existe en el catálogo
- **THEN** `direction=null`

### Scenario: Evento no-modified → null
- **GIVEN** un evento `activated` / `deactivated` / `reactivated` / etc.
- **THEN** `direction=null`, `oldPlan=null`, `newPlan=null`

## ADDED Requirement: Persistencia del par de planes en el cambio de plan
Los productores de eventos `modified` DEBEN grabar los códigos `oldPlan`/`newPlan`, manteniendo `notes` (`"OLD → NEW"`) por compatibilidad.

### Scenario: ChangePppoePlanService graba el par
- **GIVEN** un servicio con contrato y profile `IP-30M` al que se le aplica `IP-50M`
- **WHEN** se ejecuta el cambio de plan (individual o bulk)
- **THEN** el evento `modified` tiene `oldPlan='IP-30M'`, `newPlan='IP-50M'` y `notes='IP-30M → IP-50M'`

### Scenario: profile original null
- **GIVEN** un servicio con `profile=null` al que se le aplica `IP-Air-40-15`
- **THEN** el evento tiene `oldPlan=null`, `newPlan='IP-Air-40-15'`, `notes='— → IP-Air-40-15'`

## ADDED Requirement: Filtros de tópico y dirección en el historial global
`GET /api/pppoe/activation-history` DEBE aceptar `eventType` (tópico, push-down SQL) y `direction` (upgrade/downgrade, in-memory tras derivar).

### Scenario: Filtro por tópico
- **GIVEN** eventos `activated` y `modified` de internet
- **WHEN** `GET /api/pppoe/activation-history?eventType=modified`
- **THEN** responde 200 con solo el evento `modified` (el filtro se empuja al port)

### Scenario: Filtro por dirección
- **GIVEN** un `activated`, un `modified` upgrade y un `modified` downgrade
- **WHEN** `GET /api/pppoe/activation-history?direction=upgrade`
- **THEN** responde 200 con solo el evento upgrade (el `activated` y el downgrade quedan fuera por `direction≠upgrade`)

### Scenario: Permiso requerido
- **GIVEN** un usuario sin `pppoe.read`
- **THEN** responde 403; sin auth responde 401
