# Design: Orden natural de planes por código (numeric-aware)

> **(decisión post-review 2026-07-01: el catálogo muestra code; los fixtures code===name enmascaraban el mismatch)** — la clave de orden es `code` con desempate `name` → `id`, guard de null en todas las claves, sort inmutable SOLO en `ListPlans`, in-memory sin sort propio.

## Contexto

`GET /api/plans` pasa por este stack: `plan.routes.ts` → `ListPlans.execute()` → `PlanRepository.list()` → `PrismaPlanRepository.list()` → `findMany()` sin `orderBy` → los planes llegan al FE en orden no determinista.

El FE (`PlansPage`, dropdowns de PPPoE) agrupa por categoría pero confía en que el orden intra-grupo viene del BE. El operador ve `IP-Air-100-30` antes que `IP-Air-20-10` porque depende del orden de inserción en Postgres.

**Estado actual verificado del código:**

- `ListPlans.ts:6` — `return this.repo.list()` — sin sort.
- `PrismaPlanRepository.ts:24-25` — `findMany()` sin `orderBy`.
- `InMemoryPlanRepository.ts:41-43` — `list()` devuelve `this.store.map(p => ({...p}))` — en orden de inserción al store.
- `plan.routes.ts:31` — `plans.map(toPlanDto)` — preserva el orden que llega.
- Tests previos: `ListPlans.test.ts` (use case, casos vacio/single) + integration en `plan.routes.test.ts`; el orden no estaba aserado en ninguno (corregido en esta change con `ListPlans.sort.test.ts` + el test de orden en la ruta).

## Decisión 1 — El sort va en `ListPlans` (use case), NO en `PrismaPlanRepository`

**El orden de la lista de planes es una regla de negocio / contrato de API, no un detalle de presentación ni un detalle de persistencia.**

El razonamiento:

1. **Todos los consumidores deben ver el mismo orden.** Si el sort viviera en el adapter Prisma, sería un detalle que solo aplica cuando se usa ese adapter. En tests con `InMemoryPlanRepository`, el orden sería distinto. Eso viola la regla de que el test del use case debe comportarse igual que producción.

2. **Prisma no tiene sort natural numeric-aware.** `orderBy: { name: 'asc' }` ordena lexicográficamente: `IP-Air-100-30 < IP-Air-20-10 < IP-Air-50-15` — exactamente el orden incorrecto. El sort correcto requiere lógica JS que no puede expresarse como un `orderBy` de Prisma.

3. **El sort en la capa application es testeable de forma aislada.** Con el in-memory repo se pueden escribir tests deterministas sin base de datos.

4. **No viola DIP.** `ListPlans` ya depende solo de `PlanRepository` (port). Agregar un `.sort()` sobre el resultado del port es una operación de aplicación sobre datos de dominio (`Plan[]`) — capa correcta.

**Alternativa DESCARTADA — sort en `PrismaPlanRepository`:**

- Rompería la consistencia entre Prisma y el in-memory (la interfaz del port `list()` no especifica orden).
- Obligaría a replicar el comparator en el in-memory para que los tests sean confiables.
- Contamina el adapter de infraestructura con lógica de ordenamiento que no es propia del adapter.
- No funciona nativamente en Prisma (no hay `orderBy` de sort natural).

**Alternativa DESCARTADA — sort en `plan.routes.ts`:**

- Solo afectaría `GET /api/plans`. Si en el futuro hubiera otro endpoint o consumer interno que llame `ListPlans`, recibirían el orden incorrecto.
- La capa HTTP no debe tener lógica de negocio.

**Conclusión:** el sort va en `ListPlans.execute()`, inmediatamente antes del `return`. Uno o dos renglones.

## Decisión 2 — Comparator: `code` (natural) → `name` (natural) → `id`, null-safe, inmutable

**(decisión post-review 2026-07-01: el catálogo muestra code; los fixtures code===name enmascaraban el mismatch.)** El pedido del usuario es sobre el código visible (`IP-Air-20-10`) y el catálogo FE muestra `plan.code` — la clave primaria del orden es `code`, NO `name`.

```ts
// src/application/utils/naturalSort.ts
export function naturalCompare(a: string | null | undefined, b: string | null | undefined): number {
  return (a ?? '').localeCompare(b ?? '', undefined, { numeric: true, sensitivity: 'base' });
}

export function planOrderComparator(a: PlanOrderKeys, b: PlanOrderKeys): number {
  const byCode = naturalCompare(a.code, b.code);
  if (byCode !== 0) return byCode;
  const byName = naturalCompare(a.name, b.name);
  if (byName !== 0) return byName;
  const idA = a.id ?? '';
  const idB = b.id ?? '';
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}

// ListPlans.execute() — copia antes de ordenar (no muta el array del repo):
return [...plans].sort(planOrderComparator);
```

- `numeric: true` — trata secuencias de dígitos como números: `20 < 50 < 100`.
- `sensitivity: 'base'` — case-insensitive: `ip-air-20-10` == `IP-Air-20-10`.
- `locale: undefined` — usa el locale del runtime (no relevante para códigos de plan ASCII; es robusto).
- **Guard de null (`?? ''`) en TODAS las claves** — un `code`/`name` null/undefined NUNCA tira TypeError; el string vacío compara primero → posición determinista al principio.
- **Desempates `name` → `id`** — orden TOTAL determinista incluso con codes que natural-comparan igual (`CODE-1` vs `CODE-01`) o duplicados exactos. El desempate por `id` usa comparación binaria de code units para garantizar orden total.
- **Sort inmutable** — `[...plans].sort(...)`: el array devuelto por el repo no se muta.

**Resultado esperado:**

```
IP-Air-20-10   →  IP-Air-20-10
IP-Air-50-15   →  IP-Air-50-15
IP-Air-50-50   →  IP-Air-50-50
IP-Air-80-30   →  IP-Air-80-30
IP-Air-80-80   →  IP-Air-80-80
IP-Air-100-30  →  IP-Air-100-30
IP-Air-100-100 →  IP-Air-100-100
```

**Nombres no-numéricos** como `IP-BAJA`, `IP-REDUCCION` (enforcement plans) se ordenan lexicográficamente por el segmento no-numérico, lo cual es correcto y estable. El FE no los muestra en los dropdowns de alta de PPPoE (los filtra por categoría), pero aparecen en `PlansPage`.

## Decisión 3 — `InMemoryPlanRepository.list()` NO ordena; el port documenta que el orden no está garantizado

**(decisión post-review 2026-07-01 — REEMPLAZA la decisión original de esta sección.)** La primera iteración había agregado el sort también al in-memory "por consistencia". El review lo marcó como WARNING y se revirtió:

- Si el in-memory ordena, los tests de `ListPlans` NO prueban al use case — pasarían aunque el use case perdiera su sort, porque el adapter ya entrega ordenado. El test estaría probando al adapter.
- Prisma devuelve el orden de la DB (sin `orderBy`); el espejo fiel del in-memory es el **orden de inserción**, no el orden natural.
- El contrato queda documentado en el port: `PlanRepository.list()` lleva JSDoc explícito de que el ORDEN NO ESTÁ GARANTIZADO y que el orden de presentación es responsabilidad del use case.

Consecuencia: el sort vive en UN solo lugar (`ListPlans`), y hay un test que fija el comportamiento del in-memory (orden de inserción) para que nadie vuelva a meterle un sort por accidente.

## Flujo del sort (sequence)

```
GET /api/plans
  → auth + RBAC
  → listPlans.execute()
      plans = await this.repo.list()             // [IP-Air-100-30, IP-Air-20-10, ...] (orden de DB/inserción)
      return [...plans].sort(planOrderComparator) // [IP-Air-20-10, ..., IP-Air-100-30] (por code, copia inmutable)
  → plans.map(toPlanDto)
  → res.json([...sorted...])
```

## Hexagonal / DIP

- `ListPlans` (application) depende del **port** `PlanRepository`. No cambia.
- El sort opera sobre `Plan[]` — datos de dominio puro. No hay imports de infra.
- `InMemoryPlanRepository` (infrastructure) NO importa el comparator — ya no ordena (decisión post-review 2026-07-01).
- El port `PlanRepository.list()` documenta en JSDoc que el orden NO está garantizado.
- `PrismaPlanRepository` — **no se toca**. Sigue haciendo `findMany()` sin `orderBy`. El orden de Postgres es irrelevante porque `ListPlans` lo reordena.

## Open questions

Ninguna. El cambio es autónomo y no requiere decisiones externas.
