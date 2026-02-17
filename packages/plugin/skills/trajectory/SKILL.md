---
name: trajectory
description: Manage trajectories — list, show, activate, pause, resume, skip, reset, or generate new ones
argument-hint: "list | show <name> | activate <name> | pause | resume | skip <step-id> | reset <name> | generate <goal>"
---

Manage PromptWheel trajectories. Trajectories are ordered multi-step plans that guide the wheel across cycles.

## Arguments

Parse from `$ARGUMENTS` to determine the subcommand:

- **list** — List all trajectories and their status
- **show `<name>`** — Show full details of a trajectory
- **activate `<name>`** — Activate a trajectory (starts from step 1)
- **pause** — Pause the active trajectory
- **resume** — Resume a paused trajectory
- **skip `<step-id>`** — Skip a step and advance to the next
- **reset `<name>`** — Reset all step state for a trajectory
- **generate `<goal>`** — Generate a new trajectory from a high-level goal (see below)

If no subcommand is given, default to **list**.

## Subcommand Routing

### list
Call `promptwheel_trajectory_list`. Display results as a formatted table:
```
## Trajectories

| Name | Status | Progress | Description |
|------|--------|----------|-------------|
| name | active | 2/5 steps | description |
```

### show `<name>`
Call `promptwheel_trajectory_show` with `name`. Display the full trajectory with step details, showing status icons:
- Completed: [x]
- Active: [>]
- Pending: [ ]
- Skipped: [-]
- Failed: [!]

### activate `<name>`
Call `promptwheel_trajectory_activate` with `name`. Confirm activation and show the first step.

### pause
Call `promptwheel_trajectory_pause`. Confirm the trajectory is paused.

### resume
Call `promptwheel_trajectory_resume`. Confirm resumption and show the current step.

### skip `<step-id>`
Call `promptwheel_trajectory_skip` with `step_id`. Show which step was skipped and what's next.

### reset `<name>`
Call `promptwheel_trajectory_reset` with `name`. Confirm the reset.

### generate `<goal>`

This is the killer feature in the plugin — Claude already has codebase context, so no extra LLM call is needed.

1. Read the codebase structure using Glob and Read to understand the project
2. Analyze the goal and break it into ordered steps with dependencies
3. Generate a trajectory YAML with this structure:

```yaml
name: <slug-from-goal>
description: <goal description>
steps:
  - id: step-1
    title: <step title>
    description: <what to do>
    scope: "<glob pattern for relevant files>"
    categories: [<relevant categories>]
    acceptance_criteria:
      - <criterion 1>
      - <criterion 2>
    verification_commands:
      - <test command>
    depends_on: []
  - id: step-2
    title: <step title>
    ...
    depends_on: [step-1]
```

4. Write the YAML to `.promptwheel/trajectories/<name>.yaml` (create the directory if needed)
5. Ask the user if they want to activate it immediately
6. If yes, call `promptwheel_trajectory_activate` with the trajectory name

**Guidelines for generation:**
- Use 3-8 steps (not too granular, not too broad)
- Each step should be achievable in 1-3 scout cycles
- Add realistic verification commands (npm test, vitest, etc.)
- Set scope patterns to focus each step on relevant files
- Use depends_on to express ordering (later steps depend on earlier ones)
- Use snake_case for step IDs (e.g., `add-validation`, `update-tests`)
