# Change Proposal: recaptacion-leads (#80)

## Why
El equipo necesita recuperar clientes dados de baja ("recaptación"). Hoy no hay forma de registrar la gestión de recontacto: cuántas veces se llamó, qué se propuso, el resultado. Un equipo de 4-6 personas debe poder tomarse leads rápido (sin pisarse) y registrar cada contacto. A futuro entrarán leads desde CSV, pero ese scope queda fuera de este cambio.

## What Changes
- Nueva entidad de dominio `RecaptureLead` DESACOPLADA del `Client` (FK `clientId` opcional) para soportar el origen CSV futuro sin remodelar.
- Bitácora `RecaptureContact` (1 lead -> N contactos): canal, resultado, qué se propuso, nota, próximo paso.
- Pipeline de estados del lead (nuevo / en_gestion / contactado / interesado / recuperado / descartado).
- Mecanismo de **claim race-safe**: "Tomar este" y "Tomar siguiente" con guard atómico (UPDATE ... WHERE assigneeId IS NULL); si ya está tomado -> 409.
- Seeding de leads desde clientes de baja: `Client.status = 'baja'` (criterio canónico; ver design).
- Permisos RBAC nuevos: `recapture.read` (ver) y `recapture.manage` (tomar/registrar). Migración aditiva + grants. Expuestos en `/me`.
- Endpoints REST `/api/recapture/*`.
- Frontend: page `/admin/customers/recaptacion` con lista + filtros (estado, asignado, sin asignar), botones de claim, detalle del lead con timeline de contactos + form para registrar contacto. Gate `recapture.read` / `recapture.manage`.

## Scope
**In**: modelo desacoplado, claim, bitácora, pipeline, RBAC, seeding desde churned, REST, page FE.
**Out (explícito)**: import CSV (modelo queda preparado), integración de telefonía (el llamado es por app externa; solo registramos), notificaciones, métricas/reporting.

## Impact
- BE: nueva migración aditiva (tablas + enums + grants RBAC), nuevo módulo recapture (entidad/port/use-cases/dto/adapters/route), wiring en app.ts, `recapture` en RBAC_MODULES.
- FE: nueva page + api + hooks + types + ruta + entry de sidebar.
- DB: 2 tablas nuevas + 4 enums + 1 módulo RBAC + 2 permisos. Cero cambios destructivos.
