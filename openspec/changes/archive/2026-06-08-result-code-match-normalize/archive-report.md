# Archive Report — result-code-match-normalize (#36)

**Archived**: 2026-06-08. Deployed to prod (BE PR #83). No migration. BE-only.

## Disparador
45 tareas clavadas en "Registrado en IClass" sin transicionar. La página de Reconciliar (#35) decía "no se encontró cierre reciente" en OS que el usuario sabía cerradas.

## Diagnóstico (verificado en vivo — IClass API real + DB de prod + código)
- De las 12 in-flight más viejas: **8 estaban `Concluida` (id=7)** en IClass (4547, 4551, 4556, 4557, 4646, 4654, 4716, 4731) pero no se movían; 4 (4696, 4702, 4790, 4810) legítimamente abiertas (Em Analise / Fila Técnico).
- Las 8 cerraron con `motivoFechamento = "Cliente Ausente."` (**con punto**). Pero el catálogo de IClass (`GET /serviceordertypes/{id}/resultcodes`) devuelve `codigo = "Cliente Ausente"` (**sin punto**). Nuestro sync guardó bien el catálogo (71/71 mapeados, "Cliente Ausente" → stage `f3e0ab3b`).
- `IngestClosedServiceOrders.resolveResultCode` hacía match **exacto** → `"Cliente Ausente."` ≠ `"Cliente Ausente"` → `rc=null` → se espejaba pero `moved=0`. El adapter ya toleraba case + whitespace externo (`trim()` + `mode:'insensitive'`); el gap preciso era la **puntuación final**. IClass es inconsistente entre la OS (con punto) y el catálogo (sin punto).
- **Hipótesis previas descartadas por la verificación**: NO era la ventana de 29 días (las más viejas eran de hace 10 días, dentro de ventana), NO era que estuvieran abiertas (8/12 Concluidas). Verificar contra IClass real evitó codear el back-search al pedo.

## Fix
Helper puro `normalizeResultCode` (trim → lowercase → strip puntuación final → collapse whitespace interno; **conservador**: preserva puntuación interna → no colapsa codes distintos). Nuevos finders `findBySoTypeAndCodeNormalized`/`findByCodeNormalized` en el port + ambos adapters (Prisma: fetch candidatos + compare en JS; in-memory: idem). `resolveResultCode`: exact-match primero (sin cambios) + normalizado como **fallback**, preservando desambiguación por `soTypeId`.

## Sin migración ni reset
El path idempotente (`IngestClosedServiceOrders.ts:187-196`) ya re-evalúa el movimiento de stage en cada corrida para las `unchanged` (el comentario anticipaba "a case-mismatch fixed later"). Así que apenas deployó, la próxima pasada del loop de cierre mueve las clavadas solas. Cero data-fix.

## Ciclo SDD
propose → spec ∥ design → tasks → apply (14/14) → verify PASS 10/10 → archive. Suite 2576/0, tsc limpio. Helper 100% coverage.

## Archivos
BE: `normalizeResultCode.ts` (nuevo) + `IngestClosedServiceOrders.ts`, `IClassResultCodeRepository.ts` (port), `PrismaIClassResultCodeRepository.ts`, `InMemoryIClassResultCodeRepository.ts` + 3 tests.

## Efecto en prod
Las 8 clavadas (y cualquier otra con el mismo drift de puntuación) transicionan solas en la próxima corrida del loop. Verificar: `[iclass-closure] mirrored=... moved=N` con N>0 (antes moved=0).
