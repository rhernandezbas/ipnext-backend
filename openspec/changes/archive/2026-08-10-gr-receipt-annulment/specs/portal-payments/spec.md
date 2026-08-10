# Delta for `portal-payments`

Target: `openspec/specs/portal-payments/spec.md` (archivada 2026-08-05).

## MODIFIED Requirements

### Requirement: PAY-1.5 — Los recibos ANULADOS no se muestran

Un recibo con `anulado = true` NO DEBE aparecer en `GET /api/portal/payments`.

- **Por qué**: mostrarle al cliente un pago que se anuló es peor que no mostrar nada.
- **El servidor es la autoridad**: el filtro vive en el WHERE del adapter Prisma
  (`PrismaPortalPaymentsReader.ts:46`), no se delega en el ingest.

(Previously: la nota decía "el parser de `GestionRealClient` ya excluye las anulaciones REALES antes de
persistir; la columna es auditoría" — eso describía un mundo donde ningún recibo anulado llegaba a
persistirse nunca, así que el filtro del portal era defensa en profundidad sobre una columna que siempre
valía `false`. Con `gr-receipt-annulment`, el ingest deja de saltear anulados y la columna empieza a
poblarse de verdad — el filtro del portal pasa de ser profiláctico a ser la primera línea de defensa real
contra mostrar un pago anulado.)

#### Scenario: A receipt annulled by the reconcile lane disappears from Mis pagos on the next read
- GIVEN un recibo previamente visible en `GET /api/portal/payments` con `anulado: false`
- WHEN el carril reconcile lo re-consulta y GR reporta un `fecha_anulacion` real, marcándolo
  `anulado: true`
- THEN la siguiente consulta a `GET /api/portal/payments` para ese cliente YA NO incluye ese recibo

#### Scenario: Contra-escenario (revert-probe) — retirar el filtro pone el test en rojo
- GIVEN el WHERE de `PrismaPortalPaymentsReader` se modifica para no filtrar `anulado`
- WHEN corre el test de `PrismaPortalPaymentsReader` con un fixture que incluye un recibo real
  `anulado: true` y monto distinto de cero
- THEN el test se pone en rojo — el probe exige PRESENCIA del recibo anulado en el fixture antes de
  assertear su ausencia (una ausencia contra un fixture vacío no discrimina nada)

#### Scenario: A never-annulled receipt keeps appearing, unaffected
- GIVEN un recibo `anulado: false` sin cambios
- WHEN se consulta `GET /api/portal/payments`
- THEN sigue apareciendo con la misma forma (`date`, `amounts`, `method`, `appliedTo`) — PAY-1.2 a PAY-1.4
  y PAY-1.6 no cambian
