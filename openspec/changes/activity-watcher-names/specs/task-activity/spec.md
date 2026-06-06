# Spec delta: task-activity — watcher names

## ADDED Requirements

### Requirement: Watcher activity events carry the watcher's name
The activity feed MUST show WHO was added/removed as a watcher, not just "un observador".
The `watcher_added` / `watcher_removed` events MUST carry the watcher's resolved name in
`metadata` (`toName` for added, `fromName` for removed), consistent with how
`reporter_changed` / `customer_changed` / `project_changed` already carry resolved names.

#### Scenario: adding a watcher records the name
- **WHEN** a task is updated adding watcher `u1` (name "Juan Pérez")
- **THEN** a `watcher_added` event is emitted with `toValue = "u1"` and `metadata.toName = "Juan Pérez"`
- **AND** the feed renders "agregó a Juan Pérez"

#### Scenario: removing a watcher records the name
- **WHEN** a task is updated removing watcher `u2` (name "Ana Gómez")
- **THEN** a `watcher_removed` event is emitted with `fromValue = "u2"` and `metadata.fromName = "Ana Gómez"`
- **AND** the feed renders "quitó a Ana Gómez"

#### Scenario: unresolvable name degrades gracefully
- **WHEN** the watcher's name cannot be resolved (lookup miss)
- **THEN** the event is still emitted (without a name in metadata)
- **AND** the feed falls back to "agregó/quitó un observador" — never breaks
