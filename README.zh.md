# 智能模型路由

这是一个面向 DeepSeek Harness 的 Cordis Host bundle。它提供一个虚拟模型路由：让较小模型先处理普通任务或生成草稿，再由更强模型复核复杂任务。

## 功能

- 短小、常规且不使用工具的请求，直接调用弱模型。
- 较长、命中复杂任务关键词或包含工具的请求，先由弱模型起草，再交给强模型核验并生成最终答案。
- 只有选择 `smart-model-router / auto` 时才会进入路由；显式选择其他 Provider 和模型时保持原有行为。
- 弱模型草稿最多传递 `draftMaxChars` 个字符，草稿阶段最多生成 2048 tokens。
- 自迭代默认启用：每完成 `iterationEvery` 次请求，使用配置的自迭代模型评估一个有界样本，并在 500～2500 字符范围内调整内存中的复杂度长度阈值。
- 自迭代不会改写 Harness 配置文件，也不会修改 Provider、模型 ID、工具权限或系统提示词。

## 默认配置

```yaml
weakProvider: deepseek-official
weakModel: Ds4.1flash

strongProvider: openai
strongModel: gpt-6.1-sol

iterationEnabled: true
iterationProvider: openai
iterationModel: gpt-6.1-sol
iterationEvery: 20
iterationSampleChars: 4000
draftMaxChars: 10000
```

这些值可以在 Harness 的插件设置中修改。`Ds4.1flash` 使用 DeepSeek 的 `deepseek-official` Provider；模型 ID 应填写当前 Provider 实际支持的准确值。

## 安装

### 从 GitHub 克隆

```bash
git clone https://github.com/zcf1sh/smart-model-router.git
```

然后在 Harness 插件管理器中安装克隆后的目录。

### 从本地目录安装

在 Harness 的插件管理器中选择本地插件目录：

```text
smart-model-router/
```

## 使用

1. 打开 Harness 的插件设置。
2. 设置 `weakProvider`、`weakModel`、`strongProvider`、`strongModel`。
3. 设置 `iterationProvider` 和 `iterationModel`，或关闭 `iterationEnabled`。
4. 在会话模型选择器中选择：
   - Provider：`Smart model router`
   - Model：`Auto · draft + review`

## 复杂度判定

当前规则满足任意一项就进入复杂路径：

- 请求包含工具；
- 拼接后的文本长度超过当前长度阈值；
- 命中分析、比较、推导、证明、调研、研究、设计、调试、排查、实现、编程、代码、方案、评估等关键词，或对应的英文关键词。

没有工具、文本较短且没有命中关键词的请求，直接调用弱模型。

## 自迭代机制

每隔若干次请求，自迭代模型会收到以下摘要信息：

- 任务长度；
- 是否使用工具；
- 当前复杂度判定结果；
- 最终流是否失败；
- 最终答复的有界片段。

模型只允许建议新的 `lengthThreshold`。插件会验证结果并限制范围，之后应用到后续请求。阈值目前保存在插件运行内存中，Harness 重启后恢复为默认值。

## 成本与延迟

- 简单任务：一次弱模型调用。
- 复杂任务：一次弱模型起草加一次强模型复核。
- 每个 `iterationEvery` 请求额外进行一次自迭代评估。

复杂任务会增加响应延迟和模型调用次数；如果使用订阅或 OAuth 模型，主要影响调用额度和等待时间。

## 文件结构

```text
package.json
cordis.patch.yml
index.js
icon.svg
README.md
README.zh.md
locale/en.json
locale/zh.json
```

## 许可证

当前仓库未附加独立许可证文件。使用或再发布前，请根据你的部署需求补充许可证。
