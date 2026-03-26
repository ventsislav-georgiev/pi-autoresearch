<div align="center">
<img  height="120" alt="result" src="https://github.com/user-attachments/assets/c66cbd02-4491-4833-a63a-142cfd7530c1" />

# pi-autoresearch
### Autonomous experiment loop for OpenCode
**[Install](#install)** · **[Usage](#usage)** · **[How it works](#how-it-works)**

</div>

*Try an idea, measure it, keep what works, discard what doesn't, repeat forever.*

A plugin for **[OpenCode](https://opencode.ai/)** — an AI coding agent. pi-autoresearch gives the agent tools and workflow to run autonomous optimization loops: try an idea, benchmark it, keep improvements, revert regressions, repeat.

Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch). Works for any optimization target: test speed, bundle size, LLM training, build times, Lighthouse scores.

---

## Quick start

Add to your OpenCode configuration (`opencode.json`):

```json
{
  "plugin": ["pi-autoresearch@git+https://github.com/ventsislav-georgiev/pi-autoresearch.git#opencode"]
}

## What's included

| | |
|---|---|
| **Plugin** | Tools for running and recording experiments |
| **Skill** | Gathers what to optimize, writes session files, starts the loop |

### Plugin tools

| Tool | Description |
|------|-------------|
| `init_experiment` | One-time session config — name, metric, unit, direction |
| `run_experiment` | Runs any command, times wall-clock duration, captures output |
| `log_experiment` | Records result, auto-commits on keep, auto-reverts on discard/crash |

### Skill

`autoresearch-create` asks a few questions (or infers from context) about your goal, command, metric, and files in scope — then writes two files and starts the loop immediately:

| File | Purpose |
|------|---------|
| `autoresearch.md` | Session document — objective, metrics, files in scope, what's been tried. A fresh agent can resume from this alone. |
| `autoresearch.sh` | Benchmark script — pre-checks, runs the workload, outputs `METRIC name=number` lines. |
| `autoresearch.checks.sh` | *(optional)* Backpressure checks — tests, types, lint. Runs after each passing benchmark. Failures block `keep`. |

---

## Install

Add to your OpenCode configuration (`opencode.json`):

```json
{
  "plugin": ["pi-autoresearch@git+https://github.com/ventsislav-georgiev/pi-autoresearch.git#opencode"]
}
```

Or drop the plugin into `.opencode/plugins/`.

---

## Usage

### 1. Start autoresearch

Use the `autoresearch-create` skill to set up a session. The agent asks about your goal, command, metric, and files in scope — or infers them from context. It then creates a branch, writes `autoresearch.md` and `autoresearch.sh`, runs the baseline, and starts looping immediately.

### 2. The loop

The agent runs autonomously: edit → commit → `run_experiment` → `log_experiment` → keep or revert → repeat. It never stops unless interrupted.

Every result is appended to `autoresearch.jsonl` in your project — one line per run. This means:

- **Survives restarts** — the agent can resume a session by reading the file
- **Survives context resets** — `autoresearch.md` captures what's been tried so a fresh agent has full context
- **Human readable** — open it anytime to see the full history

### 3. Monitor progress

Check `autoresearch.jsonl` for the full experiment history, or read the agent's responses for per-run summaries including confidence scores, metric deltas, and ASI annotations.

---

## Example domains

| Domain | Metric | Command |
|--------|--------|---------|
| Test speed | seconds ↓ | `pnpm test` |
| Bundle size | KB ↓ | `pnpm build && du -sb dist` |
| LLM training | val_bpb ↓ | `uv run train.py` |
| Build speed | seconds ↓ | `pnpm build` |
| Lighthouse | perf score ↑ | `lighthouse http://localhost:3000 --output=json` |

---

## How it works

The **plugin** is domain-agnostic infrastructure. The **skill** encodes domain knowledge. This separation means one plugin serves unlimited domains.

```
┌──────────────────────┐     ┌──────────────────────────┐
│  Plugin (global)     │     │  Skill (per-domain)       │
│                      │     │                           │
│  run_experiment      │◄────│  command: pnpm test       │
│  log_experiment      │     │  metric: seconds (lower)  │
│  init_experiment     │     │  scope: vitest configs    │
│                      │     │  ideas: pool, parallel…   │
└──────────────────────┘     └──────────────────────────┘
```

Two files keep the session alive across restarts and context resets:

```
autoresearch.jsonl   — append-only log of every run (metric, status, commit, description)
autoresearch.md      — living document: objective, what's been tried, dead ends, key wins
```

A fresh agent with no memory can read these two files and continue exactly where the previous session left off.

---

## Configuration (optional)

Create `autoresearch.config.json` in your project directory to customize behavior:

```json
{
  "workingDir": "/path/to/project",
  "maxIterations": 50
}
```

| Field | Type | Description |
|-------|------|-------------|
| `workingDir` | string | Override the directory for all autoresearch operations — file I/O, command execution, and git. Supports absolute or relative paths (resolved against the project directory). The config file itself always stays in the project directory. Fails if the directory doesn't exist. |
| `maxIterations` | number | Maximum experiments before auto-stopping. The agent is told to stop and won't run more experiments until a new segment is initialized. |

---

## Confidence scoring

After 3+ experiments in a session, pi-autoresearch computes a **confidence score** — how the best improvement compares to the session's noise floor. This helps distinguish real gains from benchmark jitter, especially on noisy signals like ML training, Lighthouse scores, or flaky benchmarks.

**How it works:**

- Uses [Median Absolute Deviation (MAD)](https://en.wikipedia.org/wiki/Median_absolute_deviation) of all metric values in the current segment as a robust noise estimator.
- Confidence = `|best_improvement| / MAD`. A score of 2.0× means the best improvement is twice the noise floor.
- Shown in `log_experiment` output.
- Persisted to `autoresearch.jsonl` on each result for post-hoc analysis.
- **Advisory only** — never auto-discards. The agent is guided to re-run experiments when confidence is low, but the final keep/discard decision stays with the agent.

| Confidence | Meaning |
|-----------|---------|
| ≥ 2.0× | Improvement is likely real |
| 1.0–2.0× | Above noise but marginal |
| < 1.0× | Within noise — consider re-running to confirm |

---

## Backpressure checks (optional)

Create `autoresearch.checks.sh` to run correctness checks (tests, types, lint) after every passing benchmark. This ensures optimizations don't break things.

```bash
#!/bin/bash
set -euo pipefail
pnpm test --run
pnpm typecheck
```

**How it works:**

- If the file doesn't exist, everything behaves exactly as before — no changes to the loop.
- If it exists, it runs automatically after every benchmark that exits 0.
- Checks execution time does **not** affect the primary metric.
- If checks fail, the experiment is logged as `checks_failed` (same behavior as a crash — no commit, revert changes).
- Checks have a separate timeout (default 300s, configurable via `checks_timeout_seconds` in `run_experiment`).

---

## Controlling costs

Autoresearch loops run autonomously and can burn through tokens. Two ways to cap spend:

- **API key limits** — most providers let you set per-key or monthly budgets. Check your provider's dashboard.
- **`maxIterations`** — cap experiments per session in `autoresearch.config.json`:
   ```json
   {
     "maxIterations": 30
   }
   ```

## License

MIT
