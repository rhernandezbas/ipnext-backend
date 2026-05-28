# Tasks: Reassign Project on Existing Task

> Strict TDD activo: cada bloque RED → GREEN → (REFACTOR si aplica).
> BE en `ipnext-backend`, FE en `ipnext-frontend`. Repos independientes — commits separados.

---

## FASE 1 — BE: Domain + Use Cases (TDD)

### Contexto

- 14 archivos contienen `new CreateTask(` o `new UpdateTask(` — todos necesitan el 6.º arg.
- Los dedicated use-case tests viven en `src/__tests__/application/use-cases/CreateTask.test.ts` y `UpdateTask.test.ts` con factories `makeUseCase()` / `makeUpdateUC()` que aceptan overrides. Es el lugar exacto donde van los nuevos casos REQ-CREATE-12/13/14 y REQ-UPDATE-5/6/7.
- La lógica de validación de orden canónico ya existe en `CreateTask.ts` y `UpdateTask.ts`; se extiende con el bloque `project` entre `partner` y `reporter`.

### Tareas

- [x] **1.1 RED — Extender `ReferenceKind`**
  - Editar `src/domain/errors/scheduling.ts`: agregar `'project'` al union `ReferenceKind`.
  - Verificar que `npx tsc --noEmit` falla en `scheduling.routes.ts:45` porque `REFERENCE_TO_CODE` ya no es exhaustivo (Record<ReferenceKind, string> — el compilador lo detecta). Esto confirma la cadena de tipos.

- [x] **1.2 RED — Extender `makeUseCase` / `makeUpdateUC` en los test files**
  - En `src/__tests__/application/use-cases/CreateTask.test.ts`:
    - Agregar `projectLookup?: EntityLookup` al objeto `overrides` de `makeUseCase()`.
    - Pasar `overrides?.projectLookup ?? emptyLookup` como 6.º arg de `new CreateTask(...)`.
  - En `src/__tests__/application/use-cases/UpdateTask.test.ts`:
    - Igual: agregar `projectLookup` a `makeUpdateUC()` overrides y pasarlo como 6.º arg.
    - Extender `createTaskInRepo()`: agregar `projectId` al `knownIds` seed si está presente en `extraInput`.
  - Verificar que los tests existentes compilarán (TypeScript) pero los nuevos casos aún fallan.

- [x] **1.3 RED — Nuevos casos `CreateTask.test.ts`**
  Agregar al `describe('CreateTask — FK validation')`:

  ```ts
  it('REQ-CREATE-12: throws ReferenceNotFoundError(project) when projectId is not found', async () => {
    const { uc } = makeUseCase({ projectLookup: new StubLookup() }); // empty — project unknown
    await expect(uc.execute({ ...makeBase(), projectId: 'ghost-project' }))
      .rejects.toMatchObject({ kind: 'project', id: 'ghost-project' });
    await expect(uc.execute({ ...makeBase(), projectId: 'ghost-project' }))
      .rejects.toBeInstanceOf(ReferenceNotFoundError);
  });

  it('REQ-CREATE-13a: null projectId skips project lookup', async () => {
    const { uc } = makeUseCase({ projectLookup: new StubLookup() }); // would reject any id
    const result = await uc.execute({ ...makeBase(), projectId: null });
    expect(result.id).toBeTruthy();
    expect(result.projectId).toBeNull();
  });

  it('REQ-CREATE-13b: absent projectId skips project lookup', async () => {
    const { uc } = makeUseCase({ projectLookup: new StubLookup() });
    const base = makeBase();
    // omit projectId entirely — not in the payload
    const { projectId: _omitted, ...withoutProject } = base;
    const result = await uc.execute({ ...withoutProject } as typeof base);
    expect(result.id).toBeTruthy();
  });

  it('REQ-FK-ORDER: project check comes after partner and before reporter', async () => {
    const { uc } = makeUseCase({
      customerLookup: new StubLookup('cust-1'),
      serviceLookup: new StubLookup('svc-1'),
      partnerLookup: new StubLookup('part-1'),
      projectLookup: new StubLookup(), // empty — ghost project
    });
    await expect(
      uc.execute({ ...makeBase(), customerId: 'cust-1', serviceId: 'svc-1', partnerId: 'part-1', projectId: 'proj-ghost', reporterId: 'r-ghost' })
    ).rejects.toMatchObject({ kind: 'project' }); // project fails before reporter
  });
  ```

- [x] **1.4 RED — Nuevos casos `UpdateTask.test.ts`**
  Agregar al `describe('UpdateTask — FK validation')`:

  ```ts
  it('REQ-UPDATE-5: throws ReferenceNotFoundError(project) when projectId in body is not found', async () => {
    const repo = new InMemorySchedulingRepository();
    const task = await createTaskInRepo(repo);
    const uc = makeUpdateUC(repo, { projectLookup: new StubLookup() });
    await expect(uc.execute(task.id, { projectId: 'ghost-project' }))
      .rejects.toMatchObject({ kind: 'project', id: 'ghost-project' });
  });

  it('REQ-UPDATE-6: null projectId clears assignment without any lookup', async () => {
    const repo = new InMemorySchedulingRepository();
    const task = await createTaskInRepo(repo, { projectId: 'proj-abc' });
    const uc = makeUpdateUC(repo, { projectLookup: new StubLookup() }); // empty — would reject any id
    const result = await uc.execute(task.id, { projectId: null });
    expect(result?.projectId).toBeNull();
  });

  it('REQ-UPDATE-7: projectLookup NOT called when projectId is absent (undefined)', async () => {
    const repo = new InMemorySchedulingRepository();
    const task = await createTaskInRepo(repo);
    const spyLookup: EntityLookup = { findById: vi.fn().mockResolvedValue(null) };
    const uc = makeUpdateUC(repo, { projectLookup: spyLookup });
    await uc.execute(task.id, { title: 'Only title changed' });
    expect(spyLookup.findById).not.toHaveBeenCalled();
  });

  it('REQ-UPDATE-7: repo.updateTask NOT called when projectId lookup fails', async () => {
    const repo = new InMemorySchedulingRepository();
    const task = await createTaskInRepo(repo);
    const updateTaskSpy = vi.spyOn(repo, 'updateTask');
    const uc = makeUpdateUC(repo, { projectLookup: new StubLookup() });
    await expect(uc.execute(task.id, { projectId: 'ghost' })).rejects.toBeInstanceOf(ReferenceNotFoundError);
    expect(updateTaskSpy).not.toHaveBeenCalled();
  });
  ```
  Nota: importar `vi` de `vitest` si no está ya (o `jest` según config — es Jest aquí, usar `jest.fn()` y `jest.spyOn()`).

- [x] **1.5 GREEN — Implementar en `CreateTask.ts`**
  - Agregar `private projectLookup: EntityLookup` como 6.º parámetro del constructor.
  - En `execute()`, después del bloque `partnerId` y antes del bloque `reporterId`, insertar:
    ```ts
    if (data.projectId != null) {
      const found = await this.projectLookup.findById(data.projectId);
      if (!found) throw new ReferenceNotFoundError('project', data.projectId);
    }
    ```
  - Mantener el estilo `!= null` (loose) que usa `CreateTask` para los demás — no homogeneizar.
  - Tests REQ-CREATE-12/13 → GREEN.

- [x] **1.6 GREEN — Implementar en `UpdateTask.ts`**
  - Agregar `private projectLookup: EntityLookup` como 6.º parámetro del constructor.
  - En `execute()`, después del bloque `partnerId` y antes del bloque `reporterId`, insertar:
    ```ts
    if (data.projectId !== undefined && data.projectId !== null) {
      const found = await this.projectLookup.findById(data.projectId);
      if (!found) throw new ReferenceNotFoundError('project', data.projectId);
    }
    ```
  - Mantener el estilo `!== undefined && !== null` (strict) que usa `UpdateTask` — no normalizar.
  - Tests REQ-UPDATE-5/6/7 → GREEN.

- [x] **1.7 GREEN — Actualizar todos los demás call-sites en tests**
  Cada archivo que construye `new CreateTask(...)` o `new UpdateTask(...)` con 5 args debe recibir un 6.º arg `emptyLookup`. Archivos afectados (9 archivos de test adicionales):

  | Archivo | Acción |
  |---------|--------|
  | `src/__tests__/application/SchedulingUseCases.test.ts` | Agregar `emptyLookup` (el 6.º arg). El `StubLookup` local de ese archivo solo define `async findById(_id) { return null; }` — es compatible. |
  | `src/__tests__/application/ListTasksFilter.test.ts` | Ídem. |
  | `src/__tests__/application/ListTasksDateFilter.test.ts` | Ídem. |
  | `src/__tests__/infrastructure/scheduling.routes.test.ts` | Múltiples sites — ver §FASE 2 (se hace junto al wiring de routes). |
  | `src/__tests__/infrastructure/checklists.routes.test.ts` | 2 sites → `emptyLookup`. |
  | `src/__tests__/infrastructure/scheduling-composition.test.ts` | 2 sites → `emptyLookup`. |
  | `src/__tests__/infrastructure/scheduling.isClosed.test.ts` | 2 sites → `emptyLookup`. |
  | `src/__tests__/infrastructure/schedulingServiceId.routes.test.ts` | 2 sites → `emptyLookup`. |
  | `src/__tests__/infrastructure/schedulingCustomer.routes.test.ts` | 2 sites → `emptyLookup`. |
  | `src/__tests__/infrastructure/scheduling.routes.filter.test.ts` | 2 sites → `emptyLookup`. |
  | `src/__tests__/infrastructure/scheduling.inventoryReview.test.ts` | 2 sites → `emptyLookup`. |

  Para los archivos de test que no tienen `StubLookup` declarado localmente pero sí `emptyLookup`, simplemente agregar el 6.º arg igual al `emptyLookup` local (todos los archivos citados ya lo definen).

- [x] **1.8 VERIFY — Suite BE completa verde**
  ```bash
  npm test
  ```
  Todos los tests pasan. `npx tsc --noEmit` sigue reportando error en `scheduling.routes.ts` (falta `project` en `REFERENCE_TO_CODE`) — ese es el comportamiento esperado hasta FASE 2.

### Commit

```
feat(scheduling): validate projectId FK in CreateTask + UpdateTask
```

**`git add` explícito:**
```
src/domain/errors/scheduling.ts
src/application/use-cases/CreateTask.ts
src/application/use-cases/UpdateTask.ts
src/__tests__/application/use-cases/CreateTask.test.ts
src/__tests__/application/use-cases/UpdateTask.test.ts
src/__tests__/application/SchedulingUseCases.test.ts
src/__tests__/application/ListTasksFilter.test.ts
src/__tests__/application/ListTasksDateFilter.test.ts
src/__tests__/infrastructure/checklists.routes.test.ts
src/__tests__/infrastructure/scheduling-composition.test.ts
src/__tests__/infrastructure/scheduling.isClosed.test.ts
src/__tests__/infrastructure/schedulingServiceId.routes.test.ts
src/__tests__/infrastructure/schedulingCustomer.routes.test.ts
src/__tests__/infrastructure/scheduling.routes.filter.test.ts
src/__tests__/infrastructure/scheduling.inventoryReview.test.ts
```

---

## FASE 2 — BE: Routes + DI Wiring (TDD)

### Contexto

- `scheduling.routes.ts:45`: `REFERENCE_TO_CODE` es `Record<ReferenceKind, string>` — agregar `project: 'PROJECT_NOT_FOUND'` cierra el error de compilación de FASE 1.
- `scheduling.routes.ts` línea ~308 (POST handler): ya hay `data.projectId ?? null`; extender a `(data.projectId === '' ? null : data.projectId) ?? null` per REQ-CREATE-14.
- `scheduling.routes.ts` (PUT handler): agregar la misma coerción para `projectId` — REQ-CREATE-14 aplica a ambos endpoints.
- `app.ts` línea ~362: función `prismaClientLookup` — agregar case `'Project'`; línea ~464: pasar el 6.º arg a `CreateTask` y `UpdateTask`.
- `scheduling.routes.test.ts`: los sites de `buildApp()` y `buildEnrichedApp()` + los sites ad-hoc deben recibir el 6.º arg. Agregar tests de route nuevos (supertest).

### Tareas

- [x] **2.1 RED — Tests de route nuevos en `scheduling.routes.test.ts`**
  Agregar un nuevo `describe` (sugerido al final del archivo, antes del último bloque):

  ```ts
  describe('REQ-CREATE-12/UPDATE-5: projectId validation at route level', () => {
    it('POST /api/scheduling con projectId inválido → 404 PROJECT_NOT_FOUND', async () => {
      const app = buildEnrichedApp({ projectLookup: new StubLookup() }); // empty — rejects any project
      const token = await getAuthCookie(app);
      const res = await request(app)
        .post('/api/scheduling')
        .set('Cookie', token)
        .send({ ...validTaskBody(), projectId: 'ghost-project' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('PROJECT_NOT_FOUND');
    });

    it('PUT /api/scheduling/:id con projectId inválido → 404 PROJECT_NOT_FOUND', async () => {
      const repo = new InMemorySchedulingRepository();
      const task = await seedTask(repo);
      const app = buildEnrichedApp({ repo, projectLookup: new StubLookup() });
      const token = await getAuthCookie(app);
      const res = await request(app)
        .put(`/api/scheduling/${task.id}`)
        .set('Cookie', token)
        .send({ projectId: 'ghost-project' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('PROJECT_NOT_FOUND');
    });

    it('REQ-CREATE-14: POST con projectId vacío ("") → 201 con projectId null', async () => {
      const app = buildEnrichedApp({ projectLookup: new StubLookup() });
      const token = await getAuthCookie(app);
      const res = await request(app)
        .post('/api/scheduling')
        .set('Cookie', token)
        .send({ ...validTaskBody(), projectId: '' });
      expect(res.status).toBe(201);
      expect(res.body.projectId).toBeNull();
    });

    it('REQ-CREATE-14: PUT con projectId vacío ("") → 200 con projectId null', async () => {
      const repo = new InMemorySchedulingRepository();
      const task = await seedTask(repo, { projectId: 'proj-abc' });
      const app = buildEnrichedApp({ repo, projectLookup: new StubLookup() });
      const token = await getAuthCookie(app);
      const res = await request(app)
        .put(`/api/scheduling/${task.id}`)
        .set('Cookie', token)
        .send({ projectId: '' });
      expect(res.status).toBe(200);
      expect(res.body.projectId).toBeNull();
    });

    it('PUT reasignando a proyecto válido → 200 con nuevo projectId', async () => {
      const repo = new InMemorySchedulingRepository();
      const task = await seedTask(repo, { projectId: 'proj-old' });
      const app = buildEnrichedApp({ repo, projectLookup: new StubLookup('proj-new') });
      const token = await getAuthCookie(app);
      const res = await request(app)
        .put(`/api/scheduling/${task.id}`)
        .set('Cookie', token)
        .send({ projectId: 'proj-new' });
      expect(res.status).toBe(200);
      expect(res.body.projectId).toBe('proj-new');
    });
  });
  ```

  Nota: `buildEnrichedApp` ya existe en el archivo (línea ~820). Agregar un `projectLookup` opcional a su objeto `opts` — patrón idéntico a `customerLookup`, `serviceLookup`, etc.

- [x] **2.2 RED — Actualizar `buildEnrichedApp` para aceptar `projectLookup`**
  En `scheduling.routes.test.ts`, la función `buildEnrichedApp(opts?)`:
  - Agregar `projectLookup?: EntityLookup` al tipo de `opts`.
  - Pasar `opts.projectLookup ?? emptyLookup` como 6.º arg a `new CreateTask(...)` y `new UpdateTask(...)` dentro de esa función.

- [x] **2.3 RED — Actualizar `buildApp` y los sites ad-hoc en `scheduling.routes.test.ts`**
  Todos los demás sites en ese archivo (líneas ~95-96, ~495-496, ~544-545, ~589-590, ~687-688, ~730-731, ~834-835, ~1127-1128, ~1289-1290) deben recibir `emptyLookup` como 6.º arg. Son mecánicos — todos usan `emptyLookup`.

- [x] **2.4 GREEN — `REFERENCE_TO_CODE` en `scheduling.routes.ts`**
  Agregar `project: 'PROJECT_NOT_FOUND'` al objeto `REFERENCE_TO_CODE` (línea ~45). Este paso cierra el error de TypeScript del step 1.1.

- [x] **2.5 GREEN — Coerción de empty-string en POST handler (`scheduling.routes.ts`)**
  En el POST handler, localizar `data.projectId ?? null` y reemplazar por:
  ```ts
  projectId: (data.projectId === '' ? null : data.projectId) ?? null,
  ```

- [x] **2.6 GREEN — Coerción de empty-string en PUT handler (`scheduling.routes.ts`)**
  En el PUT handler, la forma en que se extrae `projectId` de `data` (puede ser parte de un spread o asignación directa). Aplicar la misma fórmula antes de pasarlo al use case:
  ```ts
  projectId: data.projectId === '' ? null : data.projectId,
  ```
  (En el PUT no se necesita el `?? null` extra porque `UpdateTaskSchema.projectId` es `.optional()` — si falta, el valor es `undefined`, que el use case omite.)

- [x] **2.7 GREEN — DI wiring en `app.ts`**
  1. En `prismaClientLookup` (línea ~362): agregar case `'Project': return prisma.project.findUnique({ where: { id }, select: { id: true } });`. Agregar comentario de una línea indicando que la función cubre cuatro entidades (Client, Service, Partner, Project) pese al nombre.
  2. En la construcción de `createTask` (línea ~464 aprox.): agregar 6.º arg `{ findById: (id) => prismaClientLookup('Project', id) }`.
  3. En la construcción de `updateTask`: ídem.

- [x] **2.8 VERIFY — Suite verde + typecheck limpio**
  ```bash
  npm test
  npx tsc --noEmit
  ```
  Ambos limpios.

### Commit

```
feat(scheduling): wire project lookup into HTTP routes, add PROJECT_NOT_FOUND mapping
```

**`git add` explícito:**
```
src/infrastructure/http/routes/scheduling.routes.ts
src/infrastructure/http/app.ts
src/__tests__/infrastructure/scheduling.routes.test.ts
```

---

## FASE 3 — BE: Typecheck + Gate Final

> No genera commit propio a menos que se descubra algo para corregir.

- [x] **3.1** `npm test` completo — verde.
- [x] **3.2** `npx tsc --noEmit` — sin errores (no warnings de TS en archivos nuevos/modificados).
- [x] **3.3** Verificar que no quedaron `console.log` de debug en ningún archivo modificado.
- [x] **3.4** Verificar que ningún commit de BE tiene `Co-Authored-By`.

---

## FASE 4 — FE: `DatosForm` — Project Select (TDD)

**Working directory**: `C:\Users\ronald\projects\ipnext\ipnext-frontend\`

### Contexto

- `DatosForm.tsx` usa `react-hook-form` con `useForm()`. El patrón para selects existentes (admins, partners) es: prop `admins: Admin[]` / `partners: Partner[]` pasada desde el padre, sin fetch interno.
- `DatosFormValues.projectId` ya existe como `string | null` — ningún cambio de tipo.
- El error de validación existente usa `formState.errors` de react-hook-form + estilos del módulo CSS del form. Replicar ese patrón para el error "Proyecto requerido".
- `useProjects()` retorna `{ data: Project[] | undefined, isLoading: boolean, ... }` — el padre fetcha, el hijo recibe el array ya resuelto.
- Tests existentes en `DatosForm.test.tsx` renderizan el componente sin `projects` prop — necesitarán un valor por defecto o una prop opcional para no romper.

### Tareas

- [x] **4.1 RED — Agregar tests de project select a `DatosForm.test.tsx`**

  Agregar antes del cierre del `describe('DatosForm')`:

  ```tsx
  const mockProjects: Project[] = [
    { id: 'proj-1', title: 'Proyecto Zeta', description: null, workflowId: null, createdAt: '', updatedAt: '' },
    { id: 'proj-2', title: 'Proyecto Alpha', description: null, workflowId: null, createdAt: '', updatedAt: '' },
  ];

  describe('project select', () => {
    it('renders project select with sorted options and placeholder', () => {
      render(
        <MemoryRouter>
          <DatosForm
            initial={{ ...initialValues, projectId: null }}
            onSubmit={onSubmit}
            isSaving={false}
            admins={mockAdmins}
            partners={mockPartners}
            projects={mockProjects}
          />
        </MemoryRouter>
      );
      const select = screen.getByLabelText(/proyecto/i) as HTMLSelectElement;
      expect(select).toBeInTheDocument();
      const options = Array.from(select.options).map(o => o.text);
      // Sorted: Alpha before Zeta; placeholder first
      expect(options[0]).toMatch(/seleccionar proyecto/i);
      expect(options[1]).toBe('Proyecto Alpha');
      expect(options[2]).toBe('Proyecto Zeta');
    });

    it('refuses submit when no project selected and shows error', async () => {
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <DatosForm
            initial={{ ...initialValues, projectId: null }}
            onSubmit={onSubmit}
            isSaving={false}
            admins={mockAdmins}
            partners={mockPartners}
            projects={mockProjects}
          />
        </MemoryRouter>
      );
      await user.click(screen.getByRole('button', { name: /guardar cambios/i }));
      await waitFor(() => {
        expect(screen.getByText(/proyecto requerido/i)).toBeInTheDocument();
      });
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('submits successfully when a project is selected', async () => {
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <DatosForm
            initial={{ ...initialValues, projectId: null }}
            onSubmit={onSubmit}
            isSaving={false}
            admins={mockAdmins}
            partners={mockPartners}
            projects={mockProjects}
          />
        </MemoryRouter>
      );
      fireEvent.change(screen.getByLabelText(/proyecto/i), { target: { value: 'proj-1' } });
      await user.click(screen.getByRole('button', { name: /guardar cambios/i }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'proj-1' })
      ));
    });

    it('hydrates select with initial projectId', () => {
      render(
        <MemoryRouter>
          <DatosForm
            initial={{ ...initialValues, projectId: 'proj-2' }}
            onSubmit={onSubmit}
            isSaving={false}
            admins={mockAdmins}
            partners={mockPartners}
            projects={mockProjects}
          />
        </MemoryRouter>
      );
      const select = screen.getByLabelText(/proyecto/i) as HTMLSelectElement;
      expect(select.value).toBe('proj-2');
    });
  });
  ```

  Importar `Project` de `@/types/project`.

- [x] **4.2 RED — Verificar tests anteriores no rompan**
  Los tests existentes que no pasan `projects` prop: si la prop es requerida, todos rompen. La estrategia es hacer `projects` OPCIONAL con default `[]` y que el select se muestre siempre (incluso vacío) — la validación de "requerido" aún aplica. Los tests viejos pasan `projectId: null` en `initialValues` — la validación de campo requerido solo dispara en submit, no en render, así que los tests que no clickean "Guardar" sobreviven. El test "calls onSubmit when form is submitted" sí clickea guardar — ajustarlo para que pase `projects={mockProjects}` y `initial={{ ...initialValues, projectId: 'proj-1' }}` para no violar el required.

- [x] **4.3 GREEN — Implementar en `DatosForm.tsx`**
  1. Agregar `projects?: Project[]` (opcional, default `[]`) a `DatosFormProps`.
  2. Registrar `projectId` en react-hook-form con `required: 'Proyecto requerido'`.
  3. Renderizar un `<select>` con `<label>` "Proyecto" (`htmlFor` que matchee el test). Opciones:
     - `<option value="">Seleccionar proyecto…</option>` (placeholder).
     - `[...projects].sort((a, b) => a.title.localeCompare(b.title)).map(p => <option key={p.id} value={p.id}>{p.title}</option>)`.
  4. Mostrar error inline si `formState.errors.projectId` — replicar el patrón de error existente (clase CSS + mensaje).
  5. Importar `Project` de `@/types/project`.
  6. Asegurar que el valor inicial del select refleja `initial.projectId` (react-hook-form `defaultValues`).

- [x] **4.4 VERIFY — Suite FE verde**
  ```bash
  npm run test -- --run
  ```
  (o `npx vitest run`) — verde.

### Commit

```
feat(scheduling): add required project select to task detail Datos form
```

**`git add` explícito:**
```
src/pages/scheduling/SchedulingTaskDetailPage/components/DatosForm.tsx
src/__tests__/scheduling/components/DatosForm.test.tsx
```

---

## FASE 5 — FE: IClass Warning (TDD)

**Working directory**: `C:\Users\ronald\projects\ipnext\ipnext-frontend\`

### Contexto

- La condición: `task.iclassOrderCode != null && formValues.projectId !== task.projectId`.
- El componente `DatosForm` ya tiene `initial.projectId` como prop. El valor actual del campo es `watch('projectId')` de react-hook-form.
- La advertencia es inline, debajo del select de proyecto. No modal, no toast.
- Props nuevas: `iclassOrderCode: string | null` y `originalProjectId: string | null` (alias semántico de `task.projectId` para que el componente no necesite conocer todo el task).

### Tareas

- [x] **5.1 RED — Nuevos tests en `DatosForm.test.tsx`**

  Agregar `describe('IClass warning')`:

  ```tsx
  describe('IClass warning', () => {
    const warningText = /ya tiene OS en IClass/i;

    it('hidden when iclassOrderCode is null', () => {
      render(
        <MemoryRouter>
          <DatosForm
            initial={{ ...initialValues, projectId: 'proj-1' }}
            onSubmit={onSubmit}
            isSaving={false}
            admins={mockAdmins}
            partners={mockPartners}
            projects={mockProjects}
            iclassOrderCode={null}
            originalProjectId="proj-1"
          />
        </MemoryRouter>
      );
      expect(screen.queryByText(warningText)).not.toBeInTheDocument();
    });

    it('hidden when project has not changed', () => {
      render(
        <MemoryRouter>
          <DatosForm
            initial={{ ...initialValues, projectId: 'proj-1' }}
            onSubmit={onSubmit}
            isSaving={false}
            admins={mockAdmins}
            partners={mockPartners}
            projects={mockProjects}
            iclassOrderCode="OS-42"
            originalProjectId="proj-1"
          />
        </MemoryRouter>
      );
      expect(screen.queryByText(warningText)).not.toBeInTheDocument();
    });

    it('visible when iclassOrderCode is set AND project changed', async () => {
      render(
        <MemoryRouter>
          <DatosForm
            initial={{ ...initialValues, projectId: 'proj-1' }}
            onSubmit={onSubmit}
            isSaving={false}
            admins={mockAdmins}
            partners={mockPartners}
            projects={mockProjects}
            iclassOrderCode="OS-42"
            originalProjectId="proj-1"
          />
        </MemoryRouter>
      );
      // Change to a different project
      fireEvent.change(screen.getByLabelText(/proyecto/i), { target: { value: 'proj-2' } });
      await waitFor(() => {
        expect(screen.getByText(warningText)).toBeInTheDocument();
      });
    });

    it('disappears when user reverts to original project', async () => {
      render(
        <MemoryRouter>
          <DatosForm
            initial={{ ...initialValues, projectId: 'proj-1' }}
            onSubmit={onSubmit}
            isSaving={false}
            admins={mockAdmins}
            partners={mockPartners}
            projects={mockProjects}
            iclassOrderCode="OS-42"
            originalProjectId="proj-1"
          />
        </MemoryRouter>
      );
      fireEvent.change(screen.getByLabelText(/proyecto/i), { target: { value: 'proj-2' } });
      await waitFor(() => expect(screen.getByText(warningText)).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText(/proyecto/i), { target: { value: 'proj-1' } });
      await waitFor(() => expect(screen.queryByText(warningText)).not.toBeInTheDocument());
    });
  });
  ```

- [x] **5.2 GREEN — Implementar warning en `DatosForm.tsx`**
  1. Agregar `iclassOrderCode?: string | null` y `originalProjectId?: string | null` a `DatosFormProps`.
  2. Obtener el valor actual del select: `const currentProjectId = useWatch({ control, name: 'projectId' })`.
  3. Derivar: `const showIClassWarning = (iclassOrderCode ?? null) != null && currentProjectId !== originalProjectId`.
  4. Renderizar condicionalmente debajo del select de proyecto:
     ```tsx
     {showIClassWarning && (
       <p className={styles.iclassWarning}>
         Esta tarea ya tiene OS en IClass. El cambio no afecta la OS creada.
       </p>
     )}
     ```
  5. Agregar `.iclassWarning` a `DatosForm.module.css` con estilo warning (fondo amarillo/amber, texto oscuro — replicar o referenciar estilos existentes en el módulo CSS).

- [x] **5.3 VERIFY — Suite FE verde**
  ```bash
  npx vitest run
  ```

### Commit

```
feat(scheduling): warn when reassigning project on a task with IClass OS
```

**`git add` explícito:**
```
src/pages/scheduling/SchedulingTaskDetailPage/components/DatosForm.tsx
src/pages/scheduling/SchedulingTaskDetailPage/components/DatosForm.module.css
src/__tests__/scheduling/components/DatosForm.test.tsx
```

---

## FASE 6 — FE: Parent Wiring + Integration

**Working directory**: `C:\Users\ronald\projects\ipnext\ipnext-frontend\`

### Contexto

- `SchedulingTaskDetailPage.tsx` ya importa `DatosForm` (vía `TaskTabs → TaskDetailsTab → DatosForm`). Las props de `DatosForm` se pasan como `detailsProps.datosForm` en el componente `TaskTabs`.
- `useProjects()` está disponible en `@/hooks/useProjects`. Retorna `{ data, isLoading }`.
- `task.iclassOrderCode` ya existe en `ScheduledTask` (verificado en el commit anterior de la page).
- `formInitial.projectId` ya se setea correctamente desde `task.projectId`.

### Tareas

- [x] **6.1** En `SchedulingTaskDetailPage.tsx`:
  1. Importar `useProjects` de `@/hooks/useProjects`.
  2. Llamar `const { data: projects = [] } = useProjects()` en el cuerpo del componente.
  3. Agregar `projects`, `iclassOrderCode: task.iclassOrderCode ?? null`, y `originalProjectId: task.projectId` al objeto `detailsProps.datosForm` que se pasa a `TaskTabs`.

- [x] **6.2** Verificar que `TaskTabs` → `TaskDetailsTab` pasa las nuevas props hacia abajo. Si `datosForm` es spreadeado en `DatosForm` directamente, ya funcionará. Si hay un tipo intermedio que hay que extender, extenderlo.

- [x] **6.3 Test de integración mínimo** en `SchedulingTaskDetailPage.test.tsx`:
  - Agregar `vi.mock('@/hooks/useProjects', ...)` que retorne `{ data: [{ id: 'p-1', title: 'Test Project', ... }], isLoading: false }`.
  - Agregar un test que verifica que el select de proyecto está presente en el detalle:
    ```tsx
    it('renders project select in task detail', async () => {
      // Setup mocks (useTask, useAdmins, usePartners, useProjects…)
      // render the page
      // expect(screen.getByLabelText(/proyecto/i)).toBeInTheDocument();
    });
    ```
  - Si el setup es demasiado costoso (la página mockea muchas cosas), marcar este test como `it.todo(...)` y confiar en los tests de `DatosForm` nivel componente. No introducir complejidad artificial.

- [x] **6.4 VERIFY — Suite FE verde**
  ```bash
  npx vitest run
  ```

### Commit

```
feat(scheduling): pipe projects + iclass warning props into DatosForm
```

**`git add` explícito:**
```
src/pages/scheduling/SchedulingTaskDetailPage.tsx
src/__tests__/scheduling/SchedulingTaskDetailPage.test.tsx
```
(más cualquier archivo de tipo intermedio como `TaskTabs.tsx` / `TaskDetailsTab.tsx` si requirió cambio de tipos)

---

## FASE 7 — FE: Typecheck + Gate Final

> No genera commit propio a menos que haya fixes.

- [x] **7.1** `npx tsc --noEmit` — sin errores en archivos modificados. Pre-existing errors en archivos no relacionados son aceptables (no los introducimos, no los resolvemos en esta tarea).
- [x] **7.2** `npx vitest run` — verde.
- [x] **7.3** No `console.log` de debug en archivos modificados.
- [x] **7.4** No `Co-Authored-By` en commits de FE.

---

## FASE 8 — Verify Checklist (Pre-push)

### Backend (`ipnext-backend`)

- [x] `git log --oneline origin/main..main` muestra exactamente 2 commits:
  - `feat(scheduling): validate projectId FK in CreateTask + UpdateTask`
  - `feat(scheduling): wire project lookup into HTTP routes, add PROJECT_NOT_FOUND mapping`
- [x] `git status` limpio (nada sin stagear).
- [x] `npm test` verde (último run limpio).
- [x] `npx tsc --noEmit` limpio.
- [ ] Ningún `console.log` de debug.
- [x] Ningún `Co-Authored-By` en los mensajes de commit.
- [x] No hay archivos `.env`, generados o binarios accidentalmente commiteados.

### Frontend (`ipnext-frontend`)

- [x] `git log --oneline origin/main..main` muestra exactamente 3 commits:
  - `feat(scheduling): add required project select to task detail Datos form`
  - `feat(scheduling): warn when reassigning project on a task with IClass OS`
  - `feat(scheduling): pipe projects + iclass warning props into DatosForm`
- [x] `git status` limpio.
- [x] `npx vitest run` verde.
- [x] `npx tsc --noEmit` limpio en archivos modificados.
- [ ] Ningún `console.log` de debug.
- [x] Ningún `Co-Authored-By`.

### Red flags (bloquean el push)

- `npm test` (BE) con algún test en rojo → no pushear.
- `npx tsc --noEmit` con errores en archivos que tocamos → no pushear.
- Algún `new CreateTask(...)` o `new UpdateTask(...)` con 5 args todavía → TypeScript lo captura (error de compilación).
- `REFERENCE_TO_CODE` sin la entrada `project` → TypeScript lo captura (Record exhaustivo).

---

## Deploy Notes

**Orden recomendado**: BE primero, luego FE.

- **BE-first (recomendado)**: agrega validación defensiva. El FE actual no envía `projectId` desde el detalle todavía (campo no existe en DatosForm hoy) → cero regresión en prod. Una vez en prod, cualquier cliente API que mandaba un `projectId` inválido (y obtenía 500) ahora obtiene 404 correctamente tipado.
- **FE-first (alternativo)**: el FE empieza a enviar `projectId` en el payload. El BE actual no valida → acepta cualquier UUID incluidos inexistentes → potencial FK error de Prisma → 500. No recomendado.
- **Deploys independientes**: permitidos per design. El BE no rompe nada si se despliega solo; el FE tampoco introduce regresión si se despliega antes (el payload ya incluía `projectId`, simplemente el usuario no podía editarlo desde DatosForm).

---

## Test Summary

| Ámbito | Tests nuevos (estimado) | Tests modificados (fixture/arg) |
|--------|------------------------|---------------------------------|
| BE — `CreateTask.test.ts` | +4 | 1 (factory) |
| BE — `UpdateTask.test.ts` | +4 | 2 (factory + createTaskInRepo) |
| BE — `scheduling.routes.test.ts` | +5 | ~12 sites mecánicos |
| BE — otros test files (9) | 0 | ~2 sites cada uno (mecánicos) |
| FE — `DatosForm.test.tsx` | +8 | 1 (calls onSubmit) |
| FE — `SchedulingTaskDetailPage.test.tsx` | +1 (o `it.todo`) | +1 mock |
| **Total nuevos** | **~22** | |
