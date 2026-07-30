# Portal Account Deletion Specification

## Purpose

El borrado de cuenta que **Google Play y App Store exigen** para toda app con login (Play:
in-app + recurso web; Apple: guideline 5.1.1(v), in-app y fácil de encontrar). Semántica
elegida: se elimina la **credencial del portal y sus datos de acceso** — NO el `Client` del ISP
(la relación contractual/facturación es independiente de la app y sigue viva). Esta distinción
se declara tal cual en la privacy policy y el Data Safety form.

**Fuera de alcance:** la página web pública de borrado (requiere el dominio/TLS — fase 4 del
EPIC; el endpoint queda listo) y el borrado del cliente como entidad del negocio.

## Requirements

### Requirement: Borrado in-app por el propio cliente
`DELETE /api/portal/account` (autenticado, `aud=portal`) DEBE (MUST) exigir la password actual
en el body como confirmación, y en éxito: eliminar el `PortalAccount`, TODAS sus `PortalSession`
y cualquier dato accesorio de la cuenta del portal. La operación es idempotente-terminal: tras
ella, los tokens emitidos dejan de servir y el DNI queda libre para una cuenta futura.

#### Scenario: Cliente borra su cuenta desde la app
- **WHEN** confirma con su password actual
- **THEN** 204, la credencial y las sesiones desaparecen, y el próximo refresh/login da 401

#### Scenario: Confirmación incorrecta
- **WHEN** la password de confirmación no coincide
- **THEN** 401 y la cuenta queda intacta

### Requirement: El Client del ISP queda intacto
El borrado NO DEBE (MUST NOT) modificar, anonimizar ni borrar el `Client`, sus contratos,
facturas, tickets ni tareas — son registros del negocio, no de la app. El operador puede
recrear la cuenta después si el cliente la vuelve a pedir.

#### Scenario: Recreación posterior
- **WHEN** un cliente que borró su cuenta pide acceso de nuevo
- **THEN** el CRUD admin puede crear una cuenta nueva para el mismo cliente y DNI sin conflicto

### Requirement: Auditoría del borrado
El borrado DEBE (MUST) dejar rastro auditable (log/evento con `portalAccountId`, `clientId` y
timestamp, sin datos sensibles) para poder responder consultas de compliance ("¿cuándo se borró?").

#### Scenario: Consulta posterior al borrado
- **WHEN** compliance pregunta por una cuenta borrada
- **THEN** existe el evento con cuenta, cliente y fecha — sin password ni tokens
