# Smart model router

中文说明：[README.zh.md](README.zh.md)

A Host-only Cordis bundle that adds the `smart-model-router` provider with one model, `auto`.

## Behavior

- Short routine prompts without tools are sent to the configured weak model in one call.
- Longer or explicitly complex prompts, and prompts with tools, use a bounded weak-model draft followed by a strong-model review. The strong model sees the original conversation and the draft; only its final stream is exposed to the Agent.
- Explicit selection of any existing provider/model is untouched. The router runs only when `smart-model-router / auto` is selected.
- `draftMaxChars` bounds how much draft text is passed to the reviewer. The preliminary generation is capped at 2,048 output tokens.
- Self-iteration is enabled by default: every `iterationEvery` completed requests, the configured iteration model receives a bounded sample and may adjust the in-memory complexity length threshold between 500 and 2,500 characters. This adds no call on other requests and does not rewrite the profile file.

## Setup

In Harness Settings → Plugins, open **Smart model router** and set all four route values using the exact provider and model IDs shown in Harness:

- `weakProvider`, `weakModel`
- `strongProvider`, `strongModel`

Then choose provider **Smart model router** and model **Auto · draft + review** in the conversation model picker. The weak-model default is the DeepSeek route `deepseek-official / Ds4.1flash`. The strong and iteration defaults use `openai / gpt-6.1-sol`; change them in plugin settings if you prefer another configured route.

## Limitations

A complex turn makes two model calls; this adds latency and can increase metered API usage. The simple-prompt path uses one weak-model call. The draft/review exchange is internal to the adapter, so the session transcript records the final Auto-selected answer, not a separate visible draft turn. Image/model capability is currently advertised as text-only.
