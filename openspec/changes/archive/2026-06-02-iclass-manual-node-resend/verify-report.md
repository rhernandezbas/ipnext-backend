# Verify Report: iclass-manual-node-resend

**Veredicto global**: PASS-con-warnings
**Fecha**: 2026-06-02
**Gate**: tsc 0 errores | tests 1956 passed / 0 failed / 86 skipped | 6 suites skipped (pre-existentes)

---

## Resumen ejecutivo

El change esta sustancialmente completo y correcto. Los 29 tasks estan checkeados
y todos los requisitos funcionales estan implementados. El gate TypeScript y la
suite de tests pasan sin errores. Se detectaron 3 WARNINGs de divergencia
especificacion-vs-implementacion (todos sin impacto funcional) y 1 SUGGESTION.
Ningun CRITICAL.

---

## Trazabilidad REQ -> Codigo

### REQ-NODES (iclass-nodes-endpoint)

| REQ         | Estado  | Ruta:Linea                                                                 | Notas                                                          |
|-------------|---------|----------------------------------------------------------------------------|----------------------------------------------------------------|
| REQ-NODES-1 | CUMPLE  | `scheduling.routes.ts:287` (GET /iclass/nodes) `scheduling.routes.ts:282` | Registrado ANTES del catch-all `/:id` (linea 326)             |
| REQ-NODES-2 | CUMPLE  | `iclassResend.routes.test.ts:244,255` (200 + empty list)                   | Test cubre lista vacia -> 200 `{ nodes: [] }`                  |
| REQ-NODES-3 | CUMPLE  | `scheduling.routes.ts:287` (auth middleware antes del handler)             | Test `iclassResend.routes.test.ts:231` cubre 401               |
| REQ-NODES-4 | CUMPLE  | `scheduling.routes.ts:284` (`resendPerm = requirePerm(...)`)               | Test cubre 403 sin permiso + super_admin short-circuit         |
| REQ-NODES-5 | CUMPLE  | `ListIClassNodes.ts:1-25` (application layer, solo IClassPort)             | Sin imports de @infrastructure; tsc 0 errores                  |

### REQ-RESEND (iclass-manual-resend)

| REQ          | Estado  | Ruta:Linea                                                                       | Notas                                                              |
|--------------|---------|----------------------------------------------------------------------------------|-------------------------------------------------------------------|
| REQ-RESEND-1 | CUMPLE  | `scheduling.routes.ts:298` (POST /:id/iclass/resend) antes de `/:id` (l.326)    | actorId = req.user?.id ?? null (linea 308)                       |
| REQ-RESEND-2 | CUMPLE  | `ResendTaskToIClassWithNode.ts:107-123` (validacion nodeCode vs listNodes)       | Norm-match; si no existe -> recordAttempt + IClassNodeNotFoundError|
| REQ-RESEND-3 | CUMPLE  | `dispatchTaskToIClass.ts:109` (`nodeCode` en CreateServiceOrderInput)            | `IClassClient.ts:301` usa `input.nodeCode ?? input.city`          |
| REQ-RESEND-4 | CUMPLE  | `dispatchTaskToIClass.ts:113-120` (setIClassOrderCode + getStageByCode + move)   | attempt success en ResendTaskToIClassWithNode.ts:138              |
| REQ-RESEND-5 | CUMPLE  | `ResendTaskToIClassWithNode.ts:73-75` (idempotencia: iclassOrderCode != null)    | No crea OS, no crea attempt; test T-14 cubre                      |
| REQ-RESEND-6 | CUMPLE  | `ResendTaskToIClassWithNode.ts:147-173` (catch Rejected/Unavailable + attempt)   | Re-lanza; errorHandler mapea a 422/502                            |
| REQ-RESEND-7 | CUMPLE  | `ResendTaskToIClassWithNode.ts:63` (TaskNotFoundError) + `scheduling.routes.ts:313`| Ruta mapea -> 404                                               |
| REQ-RESEND-8 | CUMPLE  | `ResendTaskToIClassWithNode.ts:78-99` (mapping + required fields reusando logica)| Mismo patron que SendTaskToIClass; helper dispatchToIClass no duplica|
| REQ-RESEND-9 | CUMPLE  | `scheduling.routes.ts:298` (auth + resendPerm antes del handler)                 | Tests 401/403 cubren                                             |
| REQ-RESEND-10| CUMPLE  | `ResendTaskToIClassWithNode.ts` (solo ports de dominio)                          | Ver DIP check - 0 imports de @infrastructure                     |

### REQ-AUDIT (iclass-dispatch-audit)

| REQ        | Estado  | Ruta:Linea                                                                          | Notas                                                               |
|------------|---------|-----------------------------------------------------------------------------------|--------------------------------------------------------------------|
| REQ-AUDIT-1| CUMPLE  | `prisma/schema.prisma:1632-1652` + `20260604000000_iclass_dispatch_attempt/migration.sql`| Aditiva, timestamp posterior a 20260603000000. FK Cascade OK    |
| REQ-AUDIT-2| WARNING | `IClassDispatchAttemptRepository.ts:11-16` (port con `record` no `save`)           | Ver WARNING-1 abajo                                                |
| REQ-AUDIT-3| CUMPLE  | `PrismaIClassDispatchAttemptRepository.ts` + `InMemoryIClassDispatchAttemptRepository.ts`| Ambos implementan el port; tests usan in-memory                 |
| REQ-AUDIT-4| CUMPLE  | `SendTaskToIClass.ts:116-126` (node_not_found) + `:142-161` (rejected/unavailable) | Exito en linea 132-139 NO registra attempt (correcto per AD-7)    |
| REQ-AUDIT-5| CUMPLE  | `ResendTaskToIClassWithNode.ts:112-123` (fallo nodo) + `:138-144` (exito) + `:147-173` (rejected/unavailable)| TODO intento auditado             |
| REQ-AUDIT-6| CUMPLE  | `rg '@infrastructure' src/application` -> 0 matches relevantes                    | DIP intacto; tsc 0 errores                                        |

### REQ-RBAC-RESEND (rbac-iclass-manual-resend)

| REQ               | Estado  | Ruta:Linea                                                                    | Notas                                                           |
|-------------------|---------|-------------------------------------------------------------------------------|-----------------------------------------------------------------|
| REQ-RBAC-RESEND-1 | CUMPLE  | `rbac.ts:36` `'iclass_manual_resend'` en KNOWN_ACTIONS                        | Test `src/__tests__/domain/entities/rbac.test.ts:107`          |
| REQ-RBAC-RESEND-2 | CUMPLE  | `20260604010000_rbac_iclass_manual_resend/migration.sql:3-8` (INSERT ON CONFLICT DO NOTHING)| Idempotente, usa moduleId via SELECT                  |
| REQ-RBAC-RESEND-3 | CUMPLE  | `migration.sql:10-19` (CROSS JOIN + ON CONFLICT DO NOTHING)                   | Sin IDs hardcodeados; patron identico a 20260529200000          |
| REQ-RBAC-RESEND-4 | CUMPLE  | `scheduling.routes.ts:284,287,298` (requirePerm en ambas rutas)               | Tests 401/403 en iclassResend.routes.test.ts                    |
| REQ-RBAC-RESEND-5 | CUMPLE  | `migration.sql` solo concede a super_admin (no otros roles)                   | seed.ts no agrega a administrador (correcto)                    |

---

## Hallazgos

### WARNINGs

**WARNING-1: Nombre del metodo del port: `record` vs `save` (spec)**

- Spec (REQ-AUDIT-2) define el port con `save(attempt): Promise<void>` y `listByTask` ASC.
- Design y tasks.md (T-06) explicitamente resolvieron usar `record` por consistencia con
  `AuditEventRepository.record`. La firma tambien difiere: design usa
  `record(input): Promise<IClassDispatchAttempt>` (retorna el intento creado) en vez de
  `save(): Promise<void>`.
- Esto es una divergencia documentada y deliberada (spec < design para el nombre).
- Impacto: ninguno funcional. Los adapters implementan el port correctamente.
- Archivo: `src/domain/ports/IClassDispatchAttemptRepository.ts:13`

**WARNING-2: Schema index: composito vs separados (spec vs design)**

- Spec (REQ-AUDIT-1) dice "MUST declarar `@@index([taskId])` y `@@index([createdAt])`" (dos indices).
- Design y migration usan un unico indice composito `@@index([taskId, createdAt])`.
- El indice composito es superior para `listByTask` ordenado (cubre filtro + sort en un B-tree).
- Impacto: ninguno funcional ni de correctitud. El indice composito es estrictamente mejor.
- Archivo: `prisma/schema.prisma:1651`, `migration.sql:17-18`

**WARNING-3: Firma del constructor de ResendTaskToIClassWithNode (5 args vs spec)**

- Spec (REQ-RESEND-10) muestra 3 params en el constructor (tasks, iclass, attempts).
- Design menciona 4 (tasks, featureFlags, iclass, attempts) y nota workflowId resolution.
- Implementacion tiene 5: tasks, featureFlags, iclass, attempts, stageRepo.
- `featureFlags` y `stageRepo` son ports de dominio (no hay violacion DIP). `stageRepo`
  es necesario para `getById(task.stageId)` -> workflowId (requerido por getStageByCode).
- La especificacion dice "equivalente a" (no exacto). El contrato observable es correcto.
- Impacto: ninguno funcional. Los tests existentes y de ruta pasan con esta firma.
- Archivo: `src/application/use-cases/ResendTaskToIClassWithNode.ts:47-54`

### SUGGESTIONs

**SUGGESTION-1: Nombre del helper `dispatchToIClass` vs `dispatchTaskToIClass`**

- Design (AD-3, planTDD commit 4) refiere al helper como `dispatchTaskToIClass`.
- El archivo se llama `dispatchTaskToIClass.ts` pero la funcion exportada es `dispatchToIClass`.
- Ambos callers importan `dispatchToIClass` correctamente (no hay error).
- Menor inconsistencia entre nombre de archivo y nombre de export.
- Archivo: `src/application/use-cases/dispatchTaskToIClass.ts:89`

---

## Migrations

| Migration                                          | Timestamp     | Tipo     | Aditiva | Idempotente | OK |
|----------------------------------------------------|---------------|----------|---------|-------------|-----|
| `20260604000000_iclass_dispatch_attempt`           | 20260604000000| Tabla    | SI      | N/A (CREATE)| SI |
| `20260604010000_rbac_iclass_manual_resend`         | 20260604010000| RBAC seed| SI     | ON CONFLICT DO NOTHING + CROSS JOIN| SI |

- Ambos timestamps son posteriores a `20260603000000_stage_code`. Correcto.
- La tabla migration NO toca tablas existentes: solo CREATE TABLE + CREATE INDEX + ALTER TABLE ADD CONSTRAINT.
- La migration RBAC usa transaccion (BEGIN/COMMIT), sin IDs hardcodeados. Patron identico al precedente `20260529200000`.

---

## No-duplicacion (helper dispatchToIClass)

La logica create->persist->advance vive en UN solo lugar:

- `src/application/use-cases/dispatchTaskToIClass.ts:89-136` (funcion `dispatchToIClass`)
- `SendTaskToIClass.ts:132-139` llama `dispatchToIClass(...)` (no duplica)
- `ResendTaskToIClassWithNode.ts:128-135` llama `dispatchToIClass(...)` (no duplica)

El DRY esta respetado. Ambos callers pasan `attempts: undefined` al helper y gestionan
sus propios attempts (SendTaskToIClass audita SOLO fallos; ResendTaskToIClassWithNode
audita TODO).

---

## Audit no-fatal (best-effort)

Confirmado en `dispatchTaskToIClass.ts:48-59` (funcion `recordAttempt`):

```ts
export async function recordAttempt(attempts, input): Promise<void> {
  if (!attempts) return;
  try {
    await attempts.record(input);
  } catch (e) {
    console.error('[iclass-dispatch-audit] failed to record attempt', e);
    // best-effort: NO propaga
  }
}
```

- El test "AUDIT NO FATAL" en `SendTaskToIClass.test.ts:534` confirma que un repo que
  lanza en `record` no suprime el error de dominio original.
- El envio normal (`SendTaskToIClass`) NUNCA registra exito: linea 132-139 de
  `SendTaskToIClass.ts` llama `dispatchToIClass` con `attempts: undefined`, y en el
  flujo normal (sin catch) no hay llamada a `recordAttempt`. Test
  "EXITO SIN ATTEMPT" en `SendTaskToIClass.test.ts:501` lo confirma.

---

## DIP / Hexagonal

Resultado de `rg 'from.*@infrastructure' src/application/`:
- 0 matches relevantes (solo comentarios de documentacion en archivos de sesiones).

Resultado de `rg 'from.*@prisma' src/application/`:
- 0 matches.

Ningun use case (incluyendo los nuevos `ResendTaskToIClassWithNode`, `ListIClassNodes`,
`dispatchTaskToIClass`) importa de `@infrastructure/*` ni de `@prisma/client`. DIP intacto.

---

## Wiring (app.ts)

Lineas 631-632: `PrismaIClassDispatchAttemptRepository` creado e inyectado como 4to arg en `SendTaskToIClass`.
Lineas 992-999: `ListIClassNodes` y `ResendTaskToIClassWithNode` construidos con sus deps.
Lineas 1009-1013: `resendDeps = { listIClassNodes, resendTaskToIClassWithNode, requirePerm }` pasado al router.

Las rutas nuevas estan montadas con permiso `scheduling.iclass_manual_resend` y registradas ANTES del catch-all `/:id` (linea 282 registra el bloque `if(resendDeps)` antes de la linea 326 `router.get('/:id', ...)`).

---

## Gate

| Check              | Resultado                                           |
|--------------------|-----------------------------------------------------|
| `tsc --noEmit`     | 0 errores                                           |
| `npm test`         | 1956 passed, 0 failed, 86 skipped, 6 suites skipped |
| Suites nuevas      | `InMemoryIClassDispatchAttemptRepository.test.ts` PASS |
|                    | `ResendTaskToIClassWithNode.test.ts` PASS           |
|                    | `iclassResend.routes.test.ts` PASS                  |
|                    | `src/__tests__/domain/entities/rbac.test.ts` PASS (iclass_manual_resend en KNOWN_ACTIONS)|
| Suite ampliada     | `SendTaskToIClass.test.ts` PASS (5 nuevos scenarios de audit)|
| Suite ampliada     | IClassClient override test PASS (nodeCode ?? city)  |

---

## TDD

TDD estricto respetado:

- Commit 2: test `InMemoryIClassDispatchAttemptRepository.test.ts` -> entity + port + adapters.
- Commit 3: test override `IClassClient` (nodeCode ?? city) -> cambio en IClassPort + IClassClient.
- Commit 4: test `ResendTaskToIClassWithNode.test.ts` (6 scenarios) + 5 nuevos scenarios en
  `SendTaskToIClass.test.ts` -> helper dispatchToIClass + ResendTaskToIClassWithNode + audit SendTaskToIClass.
- Commit 5: test `iclassResend.routes.test.ts` (supertest, 11 scenarios) -> ListIClassNodes + rutas + wiring.
- Commit 6: test en `rbac.test.ts` (`iclass_manual_resend` en KNOWN_ACTIONS, conteo 31) -> KNOWN_ACTIONS.

Los tests de use case usan exclusivamente adapters in-memory (nunca mockean Prisma directamente).

---

## Archivos clave verificados

| Archivo                                                                      | Estado  |
|-----------------------------------------------------------------------------|---------|
| `prisma/schema.prisma` (IClassDispatchAttempt + back-relation)              | CUMPLE  |
| `prisma/migrations/20260604000000_iclass_dispatch_attempt/migration.sql`    | CUMPLE  |
| `prisma/migrations/20260604010000_rbac_iclass_manual_resend/migration.sql`  | CUMPLE  |
| `src/domain/entities/iclass-dispatch-attempt.ts`                            | CUMPLE  |
| `src/domain/ports/IClassDispatchAttemptRepository.ts`                       | CUMPLE  |
| `src/domain/ports/IClassPort.ts` (nodeCode? en CreateServiceOrderInput)     | CUMPLE  |
| `src/domain/entities/rbac.ts` (iclass_manual_resend en KNOWN_ACTIONS)       | CUMPLE  |
| `src/infrastructure/adapters/iclass/IClassClient.ts` (nodeCode ?? city)     | CUMPLE  |
| `src/infrastructure/adapters/prisma/PrismaIClassDispatchAttemptRepository.ts`| CUMPLE |
| `src/infrastructure/adapters/in-memory/InMemoryIClassDispatchAttemptRepository.ts`| CUMPLE|
| `src/application/use-cases/dispatchTaskToIClass.ts`                         | CUMPLE  |
| `src/application/use-cases/ResendTaskToIClassWithNode.ts`                   | CUMPLE  |
| `src/application/use-cases/ListIClassNodes.ts`                              | CUMPLE  |
| `src/application/use-cases/SendTaskToIClass.ts` (4to arg optional + audit)  | CUMPLE  |
| `src/infrastructure/http/routes/scheduling.routes.ts` (rutas antes catch-all)| CUMPLE |
| `src/infrastructure/http/app.ts` (wiring completo)                          | CUMPLE  |
| `src/__tests__/infrastructure/InMemoryIClassDispatchAttemptRepository.test.ts`| CUMPLE|
| `src/__tests__/application/ResendTaskToIClassWithNode.test.ts`              | CUMPLE  |
| `src/__tests__/infrastructure/iclassResend.routes.test.ts`                  | CUMPLE  |
| `src/__tests__/domain/entities/rbac.test.ts` (iclass_manual_resend)         | CUMPLE  |
