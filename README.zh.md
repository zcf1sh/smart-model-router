# 智能模型路由

面向 DeepSeek Harness 的 Cordis Host bundle。提供一个虚拟模型 `auto`，**每一步只调用一个模型**；弱模型起草阶段是可选项，默认关闭。

## 行为

- `reviewMode: off`（默认）：每个 step 只发起一次模型调用。简单提示走弱模型，复杂提示走强模型。
- `reviewMode: on`：先让弱模型生成有界草稿，再交给强模型作答。这会让每步输入 token 翻倍，只有在质量收益明确时才建议开启。
- `auto` 上报的上下文窗口与输出上限取两条路线的**较小值**，且不携带思考档位元数据。因此经过路由的回合，其上下文压力、压缩时机、思考预算都与直接选择该模型一致。
- 每次路由调用都会清空 `reasoningEffort`，避免继承另一条路线的思考预算。
- 显式选择任何其他 Provider / 模型时，完全不经过路由。
- `lengthThreshold`：超过该字符数即判定为复杂任务。
- `iterationEnabled`（默认 `false`）：每 `iterationEvery` 次请求追加一次评估调用，可在内存中微调 `lengthThreshold`。本地计数不花 token；为控制费用请保持关闭。

## 默认配置

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

若要成本最低，把强弱两条路线指向同一个 Provider，以保持 prompt cache 命中。

## 安装与使用

在 Harness 插件设置中填写准确的 Provider 与模型 ID，然后在会话模型选择器中选择：

- Provider：`Smart model router`
- Model：`Auto · …`

也可从 GitHub 克隆后安装本地目录：

```bash
git clone https://github.com/zcf1sh/smart-model-router.git
```

## 限制

开启 `reviewMode: on` 后，单步成本比单次调用多约 `C + D` 输入 token（`C` 为对话上下文，`D` 为草稿）。起草与复核都在适配器内部完成，会话记录只保留最终答案。当前能力声明为纯文本。
