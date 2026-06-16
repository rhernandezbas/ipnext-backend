# Tasks: PPPoE Service Foundation (Fase A)

> TDD estricto (test primero). El modelo/repo van en la app; el import es script one-off fuera de `src/`.
> El **apply va en worktree** (`feat/pppoe-foundation`, BE). Estos pasos se ejecutan ahí.

## Pre-requisitos (antes del apply)
- [ ] **CSV de GR** exportado: "Exportar Usuarios" (~8431 filas, debe traer columna `pppoeUsername`) + "IPs Fijas Asignadas" (~4080). Confirmar que el CSV trae el username (open question #3 del design).
- [ ] **Acceso Sur `10.64.10.2`**: resolver ruta/firewall, o decidir importarlo por otra IP/diferido.

## Modelo (app — permanente)
- [ ] Migración aditiva `prisma/migrations/<ts>_pppoe_service/migration.sql` — `CREATE TABLE "PppoeService"` (FK `nasId`→NasServer, `contractId`→Contract nullable, `username` UNIQUE, índices). SQL generado con `prisma migrate diff` (sin DB local). Dry-run rolled-back vs prod.
- [ ] Entidad `src/domain/entities/pppoeService.ts`.
- [ ] Port `src/domain/ports/PppoeServiceRepository.ts` (upsert/list/findByUsername/findByContract).
- [ ] **(test primero)** `InMemoryPppoeServiceRepository` + tests (upsert idempotente, findByContract, multi-contrato).
- [ ] `PrismaPppoeServiceRepository` (mismo contrato; shape test).

## Matching (función pura — testeada)
- [ ] **(test primero)** `normalize()` — lowercase, sin acentos/diacríticos, sin signos, espacios colapsados. Tests de estabilidad.
- [ ] **(test primero)** `matchSecretToContract()` — cascada username→fuzzy→orphan + bucket ambiguous. Tests por cada scenario del spec.
- [ ] Elegir librería/algoritmo de similitud para el fuzzy (token-set vs Levenshtein normalizado) + umbral conservador; calibrar con la 1ª corrida real.

## Script one-off (`scripts/pppoe-import/`, fuera de `src/`)
- [ ] Lector de routers vía `node-routeros` (devDependency): `/ppp secret print` por router (proplist sin volcar password innecesario), best-effort + timeout + throttle.
- [ ] Parser del CSV de GR (usuarios + IPs fijas), sin dep nueva si se puede (parser propio, patrón del #100).
- [ ] Orquestación: barrido → matching cascada → upsert `PppoeService` (`nasId` del router) → reporte (matched-username/fuzzy/orphan/ambiguous, CSV/log).
- [ ] Credenciales server-side (NO en el script versionado): leer de env/config; nunca commitear el user/pass.

## Verificación
- [ ] `npm test` verde + `tsc --noEmit` limpio. **`app.ts` / rutas / use cases NO tocados** (el import no es runtime).
- [ ] DIP: la app no importa `node-routeros`.
- [ ] **Dry-run del script** contra 1 router (Canepa) + revisar el reporte (conteos coherentes, huérfanos ~Agote/Gowland, ambiguos para revisión) ANTES de correrlo full.
- [ ] Corrida full controlada (12 routers) + revisión de buckets `fuzzy`/`ambiguous`/`orphan`.

## Salida de la fase
- [ ] `PppoeService` poblada con el inventario real; reporte revisado. Listo el cimiento para Fase B (management) y C (cortes).
