# Report Repository Port — Specification

## Purpose

Defines the domain contract (port) for report operations. Introduced to fix a DIP violation where `ExportReport`, `GenerateReport`, and `ListReportDefinitions` use-cases imported directly from `@infrastructure/*`.

---

## Requirements

### Requirement: ReportRepository Port Exists in Domain

The system MUST provide an interface `ReportRepository` located at `src/domain/ports/ReportRepository.ts`. This interface is the sole type against which application use-cases depend for report operations.

#### Scenario: Port file is present

- GIVEN the repository has been set up
- WHEN a developer inspects `src/domain/ports/ReportRepository.ts`
- THEN the file exists and exports an interface named `ReportRepository`

#### Scenario: Application never imports infrastructure directly

- GIVEN the `src/application/use-cases/` directory
- WHEN `rg "from '@infrastructure/" src/application/use-cases/` is executed
- THEN the command returns 0 results

---

### Requirement: ExportReport Use-Case Depends on ReportRepository

The `ExportReport` use-case MUST declare its dependency on `ReportRepository` via constructor injection and MUST NOT reference any concrete Prisma or InMemory class directly.

#### Scenario: Successful report export

- GIVEN a `ReportRepository` implementation that resolves a report definition by ID
- WHEN `ExportReport.execute({ reportDefinitionId })` is called
- THEN the use-case returns exported report data
- AND no infrastructure import appears in the use-case file

#### Scenario: Report definition not found

- GIVEN a `ReportRepository` implementation that returns null/undefined for an unknown ID
- WHEN `ExportReport.execute({ reportDefinitionId: 'unknown-id' })` is called
- THEN the use-case throws a domain error (not an infrastructure error)

---

### Requirement: GenerateReport Use-Case Depends on ReportRepository

The `GenerateReport` use-case MUST declare its dependency on `ReportRepository` via constructor injection and MUST NOT reference any concrete Prisma or InMemory class directly.

#### Scenario: Successful report generation

- GIVEN a `ReportRepository` implementation that can generate a report for a valid definition
- WHEN `GenerateReport.execute({ reportDefinitionId })` is called
- THEN the use-case returns the generated report result
- AND no infrastructure import appears in the use-case file

#### Scenario: Generation fails at infrastructure level

- GIVEN a `ReportRepository` implementation that rejects (e.g., DB error)
- WHEN `GenerateReport.execute(...)` is called
- THEN the use-case propagates the error without catching it silently

---

### Requirement: ListReportDefinitions Use-Case Depends on ReportRepository

The `ListReportDefinitions` use-case MUST declare its dependency on `ReportRepository` via constructor injection and MUST NOT reference any concrete Prisma or InMemory class directly.

#### Scenario: Returns all report definitions

- GIVEN a `ReportRepository` implementation that holds N report definitions
- WHEN `ListReportDefinitions.execute()` is called
- THEN the use-case returns all N report definitions
- AND no infrastructure import appears in the use-case file

#### Scenario: Empty list

- GIVEN a `ReportRepository` implementation that returns an empty array
- WHEN `ListReportDefinitions.execute()` is called
- THEN the use-case returns an empty array (not null, not undefined)

---

## Structural Invariants

These are not user-facing scenarios but are architecture-level invariants enforced by CI/type-checking.

### Invariant: Prisma adapter class naming

Every class exported from `src/infrastructure/adapters/prisma/Prisma*.ts` MUST be named `Prisma*Repository`.

**Verification command** (MUST return 0 results):
```
rg "class InMemory.*Repository" src/infrastructure/adapters/prisma/
```

**Rationale**: A file named `PrismaFooRepository.ts` that exports `class InMemoryFooRepository` is a misleading contract — it signals "Prisma" at the file level but "InMemory" at the class level, breaking the hexagonal naming contract.

---

### Invariant: in-memory/ directory is test-only

The directory `src/infrastructure/adapters/in-memory/` MUST contain only test implementations. No production wiring (e.g., `app.ts`) MUST instantiate or import classes from `in-memory/` for production use-cases.

**Verification command** (MUST return 0 results in production wiring):
```
rg "from '.*in-memory/'" src/infrastructure/http/app.ts
```

**Rationale**: `in-memory/` adapters are test doubles. Mixing them into production composition root (`app.ts`) would silently discard data on restart.

---

### Invariant: Application layer import boundary

Files under `src/application/` MUST NOT import from `@infrastructure/*` or any relative path resolving to `src/infrastructure/`.

**Verification command** (MUST return 0 results):
```
rg "from '@infrastructure/" src/application/
```

**Type-system gate**: `tsc --noEmit` enforces this if `tsconfig.json` path aliases are correctly set. Failing this gate is a blocking error.

---

## Non-Regression Requirements

### Requirement: Existing tests continue to pass

The rename of 24 adapter classes and the introduction of the `ReportRepository` port MUST NOT break any existing test. Tests that use in-memory implementations retain their existing import paths — no test file should require modification.

#### Scenario: Full test suite passes after commit 1

- GIVEN all 24 Prisma adapter classes have been renamed from `InMemory*` to `Prisma*`
- WHEN the full test suite is executed
- THEN all tests pass (0 failures)

#### Scenario: Full test suite passes after commit 2

- GIVEN the `ReportRepository` port exists and 3 use-cases use it
- WHEN the full test suite is executed
- THEN all tests pass (0 failures)

---

### Requirement: TypeScript strict compilation passes

The system MUST compile with `tsc --noEmit` after each atomic commit with zero errors.

#### Scenario: Compile gate after rename

- GIVEN all class renames in `src/infrastructure/adapters/prisma/` are complete
- WHEN `tsc --noEmit` is run
- THEN exit code is 0 and output contains no errors

#### Scenario: Compile gate after port introduction

- GIVEN `ReportRepository` port exists and use-cases use it
- WHEN `tsc --noEmit` is run
- THEN exit code is 0 and output contains no errors

---

### Requirement: HTTP behavior of report routes is unchanged

The runtime behavior of all `/reports` HTTP endpoints MUST be identical before and after this change. The wiring in `app.ts` passes the same concrete instance — only its declared TYPE changes.

#### Scenario: Report routes respond identically

- GIVEN the application is running with the post-change wiring
- WHEN any `/reports` HTTP request that was valid before is sent
- THEN the response status, body shape, and side effects are identical to pre-change behavior
