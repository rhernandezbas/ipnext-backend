# Scheduling — hacer `scheduledDate` y `scheduledTime` opcionales

**Fecha**: 2026-05-14
**Origen**: Decisión de producto. Una tarea puede crearse "pendiente de agendar" (sin fecha/hora) y completarse después. El primer fix (forzar `required` en el front, commit `9792859` del repo `ipnext-frontend`) fue revertido el mismo día porque iba contra ese flujo de uso.

## Contexto

Hoy `POST /api/scheduling` valida con Zod (`CreateTaskSchema` en `src/application/dto/scheduling.dto.ts`):

```ts
scheduledDate:  z.string().min(1),
scheduledTime:  z.string().min(1),
```

La entidad de dominio en `src/domain/entities/scheduling.ts` declara:

```ts
scheduledDate: string;
scheduledTime: string;
```

Y la tabla `ScheduledTask` en `prisma/schema.prisma` tiene esos campos como `String` (NOT NULL):

```prisma
scheduledDate  String
scheduledTime  String
```

Eso fuerza al usuario a elegir fecha y hora al crear una tarea, incluso cuando todavía no sabe cuándo se hará.

## Plan — orden estricto (de adentro hacia afuera, hexagonal)

### 1. Domain entity — nullable

`src/domain/entities/scheduling.ts`:

```ts
// antes
scheduledDate: string;
scheduledTime: string;

// después
scheduledDate: string | null;
scheduledTime: string | null;
```

Este paso va primero porque todo lo demás depende del tipo de la entidad. Si tocás Prisma o Zod antes, el compilador TS te explota.

### 2. Zod schema — opcionales y nullables

`src/application/dto/scheduling.dto.ts` líneas 18-19:

```ts
// antes
scheduledDate:  z.string().min(1),
scheduledTime:  z.string().min(1),

// después
scheduledDate:  z.string().nullable(),
scheduledTime:  z.string().nullable(),
```

`UpdateTaskSchema` usa `.partial()` así que **hereda automáticamente** la nueva forma. No requiere cambios.

### 3. Prisma schema — nullable

`prisma/schema.prisma`, campos del modelo `ScheduledTask`:

```prisma
// antes
scheduledDate  String
scheduledTime  String

// después
scheduledDate  String?
scheduledTime  String?
```

### 4. Migration

En local:

```bash
npx prisma migrate dev --name scheduling_optional_datetime
```

Genera una migration que hace ambas columnas nullable. No requiere backfill — los datos existentes ya tienen valor.

**Ojo en prod**: el workflow `.github/workflows/deploy.yml` **NO corre `prisma migrate deploy`**. Antes de mergear a `main`:

- Opción A (manual): correr `npx prisma migrate deploy` contra la DB de prod desde el server.
- Opción B (recomendada, mata el problema de raíz): agregar el step `prisma migrate deploy` al workflow antes del `docker run`.

Si se mergea sin correr la migration, el back queda OK para los queries existentes pero cualquier `INSERT` que mande `null` en esos campos va a romper con "violates not-null constraint".

### 5. Repos: mapper, in-memory fixtures, prisma writes

#### 5a. `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts`

Función `toTask`: actualmente pasa `row.scheduledDate` directo. Después de la migration el row puede traer `null`. Ya funciona, pero confirmá tipos:

```ts
scheduledDate: row.scheduledDate ?? null,
scheduledTime: row.scheduledTime ?? null,
```

Métodos `createTask` y `updateTask`: ya pasan `data.scheduledDate`/`scheduledTime` tal cual. Funciona con `null` una vez que la columna es nullable.

#### 5b. `src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts`

Agregar al menos **una fixture nueva** con `scheduledDate: null, scheduledTime: null` para que los devs vean el caso "sin agendar" en local sin tener que crear data manualmente.

### 6. Capas de aplicación — manejar `null` en lecturas

Revisar los use cases en `src/application/use-cases/`:

- `ListTasks.ts`, `GetTask.ts`, `CreateTask.ts`, `UpdateTask.ts`, `DeleteTask.ts`, `UpdateTaskStatus.ts`
- `GetSchedulingArchive.ts` (si filtra/ordena por fecha)

Si hay algún use case que filtre por fecha (`scheduledDate >= today`) u ordene por `scheduledDate`, decidir y documentar:

- ¿Las tareas sin fecha quedan fuera del filtro o entran como bucket "sin agendar"?
- En orden ascendente por fecha, ¿van al principio o al final?

### 7. Tests

`src/__tests__/`:

- **Use case**: test que crea tarea con `scheduledDate: null` y `scheduledTime: null` y verifica que el back responde `201` con la tarea persistida.
- **Mapper**: test de `toTask` con `row.scheduledDate = null` → entity sale con `null`.
- **Route**: test de `GET /api/scheduling` que devuelve mix de tareas con y sin fecha sin romper serialización.
- **Validation**: test de Zod confirmando que `{ scheduledDate: null, scheduledTime: null, ... }` pasa la validación y `{ scheduledDate: 123, ... }` sigue fallando.

## Coordinación con el frontend

El frontend (`ipnext-frontend`) ya revirtió el `required` de los inputs en `src/pages/empresa/SchedulingPage.tsx`. Falta del lado del front:

- Cambiar el tipo `ScheduledTask` en `src/types/scheduling.ts` para que `scheduledDate` y `scheduledTime` sean `string | null`.
- Manejar `null` en la UI: no romper renders de calendario, kanban, listado y detalle cuando el campo es null.
- Mostrar las tareas "sin agendar" como un estado/columna propia en kanban y calendario (o un filtro "Pendientes de agendar").
- Capturar errores 400 restantes (otros campos) y mostrarlos al usuario en vez de cerrar el modal silenciosamente.

Ver `ipnext-frontend/md/TECH-DEBT.md` para el detalle del lado front.

## Riesgo si no se hace

- El usuario sigue forzado a inventar fecha/hora al crear una tarea, contradiciendo el flujo deseado.
- Quien quiera registrar una tarea "para agendar después" no puede hacerlo y termina poniendo fechas falsas o no creándola.
