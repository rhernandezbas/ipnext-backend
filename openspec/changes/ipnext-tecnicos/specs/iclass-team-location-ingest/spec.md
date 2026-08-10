# Delta for iclass-team-location-ingest (Wave 2a)

Extiende `TeamLocationPoint` (`schema.prisma:4277-4321`) para admitir un segundo origen (la app propia) sin tocar el ingest de IClass. Confirmado en el schema actual: la tabla NO tiene hoy `source` ni `technicianId` — son columnas nuevas.

## ADDED Requirements

### Requirement: The schema extension is additive and does not change IClass ingest behavior

El sistema DEBE (MUST) agregar `source VARCHAR DEFAULT 'iclass'` (no nulo, con default) y `technicianId String? ` (FK nullable a `RbacUser`) a `TeamLocationPoint` mediante una migración puramente aditiva.

El ingest de IClass (`IClassTeamLocationSource.ts`, `TeamLocationIngestRun`/`TeamLocationIngestState`) NO DEBE (MUST NOT) requerir ningún cambio de código para seguir funcionando: sus filas caen en `source='iclass'` por el default de columna, `technicianId=null`.

#### Scenario: Existing IClass ingest keeps working untouched
- GIVEN el ingest de IClass corre exactamente como hoy, sin cambios de código
- WHEN persiste un punto nuevo
- THEN la fila queda con `source='iclass'`, `technicianId=null`, igual que antes de la migración

#### Scenario: Rollback leaves the columns inert
- GIVEN la migración ya corrió
- WHEN se revierte el código de la wave 2b (apaga el ingest de la app) sin revertir el schema
- THEN el ingest de IClass sigue funcionando igual — las columnas nuevas quedan sin uso, no rompen nada

### Requirement: App-origin points carry technicianId, IClass-origin points do not

El sistema DEBE (MUST) dejar `technicianId=null` en toda fila `source='iclass'` (la identidad de cuadrilla en IClass no resuelve a un técnico individual) y `technicianId` NO NULO en toda fila `source='app'`.

#### Scenario: technicianId is null for IClass-origin points
- GIVEN un punto ingresado por el ingest de IClass
- WHEN se persiste
- THEN `technicianId` es `null` y `source` es `'iclass'`

## Aditivo, solo-crece

**Edge case NO resuelto por este spec** (a decidir en sdd-design): la unicidad existente `@@unique([teamLogin, recordedAt, latitude, longitude])` (`schema.prisma:4309`) NO incluye `source`. Si un punto de la app coincide EXACTAMENTE en `teamLogin`+`recordedAt`+`latitude`+`longitude` con uno de IClass (coincidencia improbable pero no imposible dado el redondeo de coordenadas), la segunda escritura colisiona con la constraint existente. No se propone cambiarla en esta wave (es aditiva, no se toca lo existente) — se deja documentado como riesgo residual, no como comportamiento verificado.
