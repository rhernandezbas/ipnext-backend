# Design: recapture-assignable-roles

## Regla de asignable (única fuente semántica)
```
asignable(user) := user.status === 'active'
                && roleCodes.length > 0
                && !isTechnicalRoleSet(roleCodes)   // ninguno es 'tecnico'
```
- `isTechnicalRoleSet(codes) := codes.some(c => TECHNICAL_ROLE_CODES.includes(c))`
- Un set vacío da `isTechnicalRoleSet = false`, por eso la condición `length > 0` es
  IMPRESCINDIBLE: sin ella, un usuario sin roles pasaría el filtro. Decisión fija del usuario:
  el sin-rol NO es asignable.

## Enforcement doble capa
- **FE** (defensa UX, no de seguridad): filtra el pool para que el admin no elija un target
  inválido. `useAssignableOperators` es el único predicado; los 3 selects lo consumen.
- **BE** (defensa real): re-valida en el use case. El FE puede tener data cacheada o un
  cliente API puede saltearse el filtro; el 422 es la barrera dura.

## Orden de validación en el use case (importa)
1. `operatorId === null` → OMITIR todo (desasignar no valida).
2. `userLookup.findById(operatorId)` → si no existe: `ReferenceNotFoundError` (**400**).
3. `roleLookup.listRoleCodes(operatorId)` → si NO asignable: `RecaptureAssigneeNotAllowedError` (**422**).

La existencia va PRIMERO para que un ghost dé 400/`REFERENCE_NOT_FOUND` (no 422). Un usuario
que existe pero es técnico/sin-rol da 422.

## Bulk: chequeo pre-loop
El target es el MISMO para todos los leads del batch, así que el chequeo de existencia+rol
corre UNA vez antes del loop. Si falla, se lanza ANTES de tocar cualquier lead → atomicidad
del rechazo (ningún lead queda a medias).

## Puerto nuevo `UserRoleLookup`
```ts
interface UserRoleLookup { listRoleCodes(userId: string): Promise<string[]>; }
```
- Minimal por diseño: sólo códigos de rol. Evita arrastrar `RbacUserRepository` completo a la
  capa de aplicación (DIP estricto: el use case depende del puerto, no del adapter).
- Wiring en `app.ts`: `roleLookupForRecapture` envuelve
  `rbacUserRepo.listRolesForUser(id).then(rs => rs.map(r => r.code))` — mismo patrón que
  `userLookupForScheduling`.
- El 3er arg del constructor es REQUERIDO (no opcional) para forzar el wiring en todos los
  call-sites y que el compilador atrape cualquier olvido.

## Contrato de error BE↔FE
| Caso | Error dominio | HTTP | code (wire) |
|------|---------------|------|-------------|
| target técnico / sin-rol | `RecaptureAssigneeNotAllowedError` | 422 | `RECAPTURE_ASSIGNEE_NOT_ALLOWED` |
| target inexistente | `ReferenceNotFoundError` | 400 | `REFERENCE_NOT_FOUND` |
| lead inexistente | `RecaptureLeadNotFoundError` | 404 | `RECAPTURE_LEAD_NOT_FOUND` |

## Alternativas descartadas
- **Reusar `SYSTEM_ROLES` con una blacklist inline**: se prefirió `TECHNICAL_ROLE_CODES` como
  lista propia y helper testeable, para que ampliar/reducir la exclusión sea un cambio de una
  línea y quede espejado 1:1 en FE.
- **Enforcement sólo en FE**: descartado — deja el BE abierto a asignar técnicos vía API.
- **Puerto genérico que devuelva `RbacRole[]`**: descartado — el use case sólo necesita
  códigos; devolver menos mantiene el puerto chico y la capa de aplicación limpia.
