---
name: status
description: Show current PromptWheel session status
---

Call the `promptwheel_session_status` MCP tool and display the results.

Show: current phase, step count, budget remaining, tickets completed/failed, spindle risk level, and time remaining.

## Trajectory Status

Also call `promptwheel_trajectory_list` to check for active trajectories. If a trajectory is active, include:

```
### Active Trajectory: <name>
Progress: step N/M — "<current step title>"
Status: active | paused
```

If the trajectory is paused, note that it can be resumed with `/promptwheel:trajectory resume`.

## Formula

If the session status includes a formula name, display it:
```
Formula: <formula name>
```
