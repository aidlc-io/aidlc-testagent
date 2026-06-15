# eval/ — self-eval harness (STUB)

Phase 1 seeds this as scaffolding; it is hardened in later phases (PRD §10).

The idea: the project dogfoods on its own input manifest. The public demo targets
double as the product demo, the agent's regression suite, and the acceptance
criteria for "the agent works." This directory captures, per target, the
**expected coverage** the agent should reach so runs can be scored beyond a
binary green/red.

## Layout (planned)

```
eval/
├── README.md
└── expected/
    └── <target>.md     # expected scenarios / coverage notes for one target
```

## Today (Phase 1)

- `expected/saucedemo.md` lists the scenarios a good plan should cover for the
  SauceDemo checkout feature. A future `ata eval` will diff a run's `plan.json`
  `tracesTo` coverage against these expectations and report gaps.

This is intentionally a stub — there is no `ata eval` command yet.
