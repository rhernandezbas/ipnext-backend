# Spec: Veredicto 200/207 de la baja de TV (#74)

## Requirement: El OTT no cuenta para el veredicto cuando el renew tuvo éxito

El endpoint `POST /customers/:id/cancel` responde **200** cuando el desmontaje fue OK y el renew del CIC tuvo éxito, AUNQUE el paso OTT (`ottDisabled`) haya fallado — porque el renew resetea la cuenta y deja el CIC viejo (con su OTT) inaccesible.

Definición:
```
renewSucceeded = renewAttempted && renew !== null
partial =
  failed.length > 0 ||
  local === 'failed' ||
  (renewAttempted && renew === null) ||
  (!ottDisabled && !renewSucceeded)
```
Responde `207` si `partial`, si no `200`.

### Scenario: renew OK + OTT no apagado → 200 (EL FIX, caso #74)
- GIVEN `failed=[]`, `local='synced'`, `ottDisabled=false`, `renewAttempted=true`, `renew={oldCic,newCic}`
- THEN el endpoint responde **200** (antes daba 207)
- AND el cuerpo reporta el renew exitoso (CIC renovado)

### Scenario: renew OK + OTT apagado → 200
- GIVEN `failed=[]`, `local='synced'`, `ottDisabled=true`, `renewAttempted=true`, `renew={...}`
- THEN **200**

### Scenario: renew intentado y fallido → 207
- GIVEN `failed=[]`, `local='synced'`, `ottDisabled=true`, `renewAttempted=true`, `renew=null`
- THEN **207** (la cuenta vieja sigue viva: el renew no la reseteó)

### Scenario: renew fallido + OTT no apagado → 207
- GIVEN `failed=[]`, `local='synced'`, `ottDisabled=false`, `renewAttempted=true`, `renew=null`
- THEN **207**

### Scenario: nada que renovar + OTT viejo activo → 207
- GIVEN `failed=[]`, `local='synced'`, `ottDisabled=false`, `renewAttempted=false`
- THEN **207** (no hubo renew que resetee la cuenta; el OTT viejo sigue activo = parcial real)

### Scenario: cuenta ya pelada → 200
- GIVEN `failed=[]`, `local='synced'`, `ottDisabled=true`, `renewAttempted=false`, `renew=null`
- THEN **200** (sin OTT que apagar, nada que renovar)

### Scenario: pack falló → 207
- GIVEN `failed.length > 0`
- THEN **207** (renew bloqueado por guard #64)

### Scenario: reconcile local falló → 207
- GIVEN `failed=[]`, `local='failed'`
- THEN **207**

## Requirement: El modal FE refleja el mismo veredicto y un copy honesto

### Scenario: renew OK → banner de éxito sin "OTT sigue activo"
- GIVEN la respuesta es 200 con `renew` presente
- THEN el FE muestra el banner de ÉXITO (no el parcial)
- AND NO presenta "OTT sigue activo" como problema
- AND comunica que la cuenta fue reiniciada (CIC nuevo) y el acceso anterior queda invalidado

### Scenario: parcial real → banner parcial reporta OTT solo si renew no reseteó
- GIVEN la respuesta es 207 y el renew NO reseteó la cuenta (`!renewSucceeded`)
- THEN el banner parcial puede reportar el paso OTT como pendiente
- BUT cuando `renewSucceeded` el OTT no se reporta como problema
