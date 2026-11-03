# catch-a-cheat - the 60-second "watch it fire" demo

The headline feature, made runnable. `./run-demo.sh` spins up a throwaway repo where an
agent "fixes" a failing test **by editing the test to expect the bug** - the code stays
broken, but the suite goes green. PromptWheel's reward-hack detection (on by default)
re-proves the win from the agent's *source* edits alone, sees it changed **zero
production-source files**, and returns:

```
  ▲ tests_pass                0 →        1  (+1, improved) [guard✓, high]
      🚩 GAMED, the "win" changed zero production-source files, only test/config/grader/golden

  VERDICT: GAMED, a metric "improved" by editing the goalposts, not the source
  (exit 2)
```

**This is illustrative, not evidence.** A hand-built cheat shows you the *mechanism*; it
says nothing about how often real agents do this. It's here so you can watch the detector
trip in one command - then point it at your own repo's real history (`promptwheel run
--base <commit>~1 --head <commit>`) where a flag actually means something.

Run it:

```bash
./run-demo.sh      # from a clone; uses the local bin/promptwheel.mjs
```

For the npm-flow version (what a newcomer copy-pastes), see the 60-second block in the
top-level [README](../../README.md#catch-your-agent-cheating-in-60-seconds).
