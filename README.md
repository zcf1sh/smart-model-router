# Smart model router

中文说明：[README.zh.md](README.zh.md)

A Host-only Cordis bundle that adds the `smart-model-router` provider with one model, `auto`. Each step is routed to **exactly one** configured model; the weak-draft pass is optional and off by default.

## Behavior

- `reviewMode: off` (default) — one model call per step. Simple prompts go to the weak model, complex prompts to the strong model.
- `reviewMode: on` — a bounded weak-model draft is added before the strong model answers. This doubles input tokens per step; enable only when the extra quality is worth it.
- The advertised `auto` model reports the **smaller** context window and output cap of the configured routes, and carries no reasoning metadata. A routed turn therefore keeps the harness's context pressure, compaction, and thinking budget identical to a direct selection of that route.
- `reasoningEffort` is cleared on every routed call, so each route uses its own adapter default instead of inheriting another route's thinking budget.
- Explicit selection of any provider/model bypasses the router entirely.
- `lengthThreshold` is the character count above which a prompt is treated as complex.
- `iterationEnabled` (default `false`) adds one evaluation call per `iterationEvery` requests, which may tune `lengthThreshold` in memory. Local counters cost nothing; leave this off to avoid extra spend.

## Defaults

```yaml
weakProvider: deepseek-official
weakModel: deepseek-flash

strongProvider: openai
strongModel: gpt-6.1-sol

reviewMode: off
lengthThreshold: 900
draftMaxChars: 8000

iterationEnabled: false
iterationProvider: openai
iterationModel: gpt-6.1-sol
iterationEvery: 50
iterationSampleChars: 2000
```

For the lowest cost, point both routes at the same provider so prompt caching stays warm.

## Setup

In Harness Settings → Plugins, open **Smart model router** and set the route values using the exact provider and model IDs shown in Harness. Then choose provider **Smart model router** and model **Auto · …** in the conversation model picker.

## Limitations

With `reviewMode: on`, one step costs roughly `C + D` more input tokens than a single call, where `C` is the conversation context and `D` the draft. The draft/review exchange is internal to the adapter, so the session transcript records only the final answer. Capability is advertised as text-only.
