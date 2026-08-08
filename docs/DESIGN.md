# pi-press 预压缩设计

## 目的

`pi-press` 用于改善 Pi 原生上下文压缩的等待体验，同时保持 Pi 原生会话格式和上下文语义。

核心目标：

- 上下文使用量达到约 80% 时，在后台提前生成一份预压缩结果。
- 后台任务执行期间，当前 agent 继续运行，不中止当前操作。
- 预压缩结果持久化到当前 session 的 JSONL 文件。
- Pi 真正触发 compaction 时，扩展返回已经生成的 `CompactionResult`，由 Pi 写入正式 `compaction` entry。
- 正式压缩后的恢复、分支和 TUI 行为继续使用 Pi 的实现。

Pi-press 自行实现并维护以下内容：

- checkpoint 的调度、持久化、校验、去重、消费和失效；
- 后台任务的超时、取消与并发控制；
- 当前 Pi 公开 preparation 接口缺少的窄版本适配模块。

实现按接口稳定性分为三层：

1. 首选 Pi 扩展契约：`turn_end`、`session_before_compact`、`session_compact`、`session_shutdown`、`session_before_tree`、`session_tree`、`pi.appendEntry()`、`ctx.getContextUsage()`、`ctx.sessionManager` 和 `ctx.modelRegistry`。
2. 公开包根入口：`VERSION`、`compact`、`findCutPoint`、`estimateTokens`、`calculateContextTokens`、`getLastAssistantUsage`、`buildSessionContext`、`sessionEntryToContextMessages` 和相关公开类型。
3. Pi-press 版本适配模块：构造 `Parameters<typeof compact>[0]` 所表示的 preparation，补足 `prepareCompaction()` 未从包根入口导出的能力。

版本适配模块只负责：识别前次正式 compaction 边界、选择切分点、构造 `messagesToSummarize`/`turnPrefixMessages`、累计文件操作并填充 preparation。摘要提示词、split turn 双摘要、`previousSummary` 更新、usage 合并以及 `<read-files>`/`<modified-files>` 附加均由 Pi 公开的 `compact()` 完成。

以下接口不得作为实现依赖：

- 标注为测试用途的 `parseSessionEntries()`；
- 包导出表之外的 `prepareCompaction()` 或其他深层模块；
- 手工读取、解析或修改当前 session JSONL；
- 手工写入正式 `type: "compaction"` entry。

自定义摘要提示词属于后续扩展，首个版本只使用当前 Pi 公开的 `compact()`。

## 非目标

- 修改 `pi-mono` 核心源码或要求 Pi 增加专用 API。
- 在当前 provider 请求已经发出后修改该请求的上下文。
- 维护项目级事实文档。
- 删除或重写原始 session entry。
- 手动写入 Pi 的正式 `type: "compaction"` entry；正式 entry 由 Pi 根据扩展返回的 `CompactionResult` 写入。

## 兼容范围

- 依赖和 peer dependency 使用 `>=0.84.1`，不通过固定版本停用扩展行为；运行时尝试使用当前 Pi 的公开契约。
- 当前包根 `VERSION` 写入 checkpoint provenance，并用于拒绝复用其他 Pi 版本生成的 checkpoint。版本升级后会生成新的 checkpoint。
- 公开 API、provider、超时、结果校验或 checkpoint 追加失败时，通过 CLI 通知显示错误，当前 compaction 返回空结果并由 Pi 原生流程继续处理；生成阶段容量预测不满足目标时只记录诊断并跳过 checkpoint。
- 所有运行时导入必须来自包根入口，禁止通过 `dist/core/...` 引用深层模块。
- 目标契约包括 coding-agent 的扩展事件、`CompactionResult`、公开 SessionManager 读取接口、custom entry 和上下文重建规则。
- `@earendil-works/pi-agent-core` harness 使用不同的 compaction 契约，不属于本设计的目标实现。
- checkpoint 使用独立的协议版本。未知版本、损坏数据和无效 entry 引用必须被忽略，并回退到 Pi 原生 compaction。
- Pi 版本升级后必须重新执行版本适配模块的差异测试和扩展集成测试。

## 核心模型

该扩展使用预压缩检查点（pre-compaction checkpoint）。检查点保存一份由 Pi 公开 `compact()` 生成的 `CompactionResult`，以及生成时的会话边界和算法版本。

```text
上下文达到软阈值
        |
        v
turn_end 处理器通过公开 SessionManager 读取当前分支并立即返回
        |
        v
detached task 通过版本适配模块构造 CompactionPreparation
        |
        v
公开 compact() 使用当前有效 provider 生成完整 CompactionResult
        |
        v
校验 session、分支祖先、正式 compaction epoch 和算法版本
        |
        v
pi.appendEntry() 追加 pi-press custom checkpoint
        |
        v
主 agent 继续运行并产生新的原始消息
        |
        v
Pi 触发 session_before_compact
        |
        v
Pi-press 校验压缩后的预计 token，并返回 checkpoint 结果
        |
        v
Pi 追加正式 compaction entry 并重建上下文
```

软阈值阶段只生成和保存检查点，不改变当前 agent 的运行时上下文。正式 compaction 发生后，Pi 才通过正式 compaction entry 应用摘要和保留边界。

checkpoint 是扩展 custom entry，只用于持久化状态，不进入 LLM 上下文。最终生效的 `type: "compaction"` entry 由 Pi 写入，因此正式 session entry、恢复、分支和 TUI 行为继续使用 Pi 的实现。

如果后台 checkpoint 未完成、已失效、压缩后预计 token 超过限制或当前 compaction 类型不受支持，`session_before_compact` 返回空结果，由 Pi 使用原生摘要流程。

## 触发规则

### 后台预压缩

- 监听 `turn_end`，只同步读取使用量、创建快照和调度任务。处理器不得等待摘要 Promise，必须立即返回。
- detached task 必须由调度器保存 Promise，并设置统一错误处理，禁止产生未处理的 Promise rejection。
- 只使用 `ctx.getContextUsage()` 判断阈值。返回 `undefined`、`tokens: null` 或 `percent: null` 时跳过本次检查，不自行估算系统提示词和工具定义占用。
- 默认软阈值为活动模型上下文窗口的 80%。该值是最早启动点，不是复用 checkpoint 的充分条件。
- Pi-press 通过 `precomputeMode: "off" | "threshold" | "threshold-and-manual"` 明确控制是否生成和消费检查点，默认值为 `"threshold"`。当前公开扩展接口无法查询 Pi 的 auto-compaction 设置，因此不得读取 settings 文件推断运行时状态。
- 同一 session、同一正式 compaction epoch 和同一 snapshot key 同时只运行一个后台任务。
- snapshot key 由 session ID、正式 compaction epoch、`snapshotSourceLeafId`、Pi 版本、preparation 算法版本、摘要格式版本和 preparation 配置 fingerprint 组成，只用于后台去重。生成模型和 thinking level 只写入 provenance，不参与该键。
- 后台任务不会调用 `ctx.compact()`，避免中止当前 agent 操作。
- 任务使用独立的 `AbortController`，不复用当前 agent 的请求信号。
- 同一时间最多执行一个后台摘要请求。前台与后台共用 provider 时记录前台耗时、429/限流错误和后台耗时，用于评估并发影响。
- 可配置一次接近原生阈值的 checkpoint 刷新；只有预计压缩后 token 超过目标比例时才允许刷新，避免固定 80% 快照保留过多后续消息。

### 正式 compaction

- 首个版本只复用 `reason: "threshold"`，以及 `precomputeMode: "threshold-and-manual"` 下无 `customInstructions` 的 `reason: "manual"`。
- `reason: "overflow"` 一律返回空结果，由 Pi 原生实现处理；`overflow && willRetry` 的失败 turn 语义不在首个版本中自行判断。
- `customInstructions` 存在时不复用默认 checkpoint。
- ready checkpoint 按祖先兼容关系选择，不要求 snapshot key 与当前叶子相同。
- 如果存在兼容但仍在生成的后台任务，hook 可以在配置的时间内等待；等待同时受事件 `signal` 限制。
- 等待超时后中止对应后台任务并返回空结果，避免后台摘要和 Pi 原生摘要同时继续执行。
- 等待成功后通过 `ctx.sessionManager.getBranch()` 重新读取当前分支，不使用事件开始时的旧快照。
- 没有有效检查点时返回空结果，由 Pi 使用原生摘要流程。

扩展不在 `agent_end` 或 `agent_settled` 中主动调用 `ctx.compact()`。

## 配置契约

Pi-press 配置独立于 Pi 的运行时 settings。配置文件按全局到项目的顺序合并：全局文件为 `getAgentDir()/pi-press.json`，项目文件为 `cwd/CONFIG_DIR_NAME/pi-press.json`；项目中存在的字段覆盖同名全局字段，缺失字段继承全局值，最后使用默认值补全。两个配置位置解析为同一文件时只读取一次。`"threshold"` 模式按 Pi-press 自身策略生成 checkpoint；如果 Pi auto-compaction 已关闭，该 checkpoint 可能不会被消费。当前公开接口无法可靠识别这一状态，使用方应显式选择 `"off"` 或允许手动消费的 `"threshold-and-manual"`，实现不得读取 settings 文件推断。首个版本使用以下字段：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `precomputeMode` | `"threshold"` | `"off"` 停用；`"threshold"` 只服务自动 threshold compaction；`"threshold-and-manual"` 也服务无自定义指令的手动 compaction |
| `softThresholdPercent` | `80` | 最早启动后台任务的上下文百分比 |
| `checkpointKeepRecentTokens` | `20000` | 构造候选 preparation 时保留的近期 token，默认取当前 Pi 的 `DEFAULT_COMPACTION_SETTINGS` |
| `summaryReserveTokens` | `16384` | 传给候选 preparation 的摘要输出预算，默认取当前 Pi 的 `DEFAULT_COMPACTION_SETTINGS` |
| `taskTimeoutMs` | `120000` | 单次后台任务总超时 |
| `hookWaitTimeoutMs` | `1000` | 正式 compaction 等待兼容 in-flight 任务的最长时间 |
| `targetPostCompactionPercent` | `50` | 消费 checkpoint 后允许的最大上下文比例 |
| `maxRefreshesPerEpoch` | `1` | 同一正式 compaction epoch 内允许的 checkpoint 刷新次数 |
| `maxRetries` | `1` | 后台摘要的瞬时错误重试次数 |

压缩后 token 校验额外预留 `max(4096, ceil(contextWindow * 0.02))` 的安全余量。实现必须校验百分比、token 和超时字段的范围；无效配置使用默认值并记录诊断。

配置 fingerprint 参与 snapshot key，防止同一内容在不同生成配置下错误去重。已生成 checkpoint 不因模型、thinking level 或预算配置变化自动失效；消费时始终使用当前模型和当前 `session_before_compact.preparation.settings` 重新校验容量。`precomputeMode` 变为 `"off"` 时中止 in-flight 任务并停止消费 ready checkpoint。

## 预压缩检查点 JSONL 契约

扩展通过 `pi.appendEntry()` 追加 custom entry。该 entry 不进入 LLM 上下文，只用于持久化预压缩结果。正式 `type: "compaction"` entry 不由扩展追加。

```json
{
  "type": "custom",
  "customType": "pi-press.precompaction",
  "data": {
    "version": 3,
    "piVersion": "current-pi-version",
    "algorithmVersion": 1,
    "summaryFormatVersion": 1,
    "checkpointId": "checkpoint-1",
    "sessionId": "session-1",
    "snapshotLeafId": "entry-42",
    "snapshotSourceLeafId": "entry-41",
    "epochCompactionId": null,
    "snapshotKey": "session-1:null:entry-41:current-pi-version:1:1:config",,
    "compaction": {
      "summary": "...",
      "firstKeptEntryId": "entry-18",
      "tokensBefore": 76000,
      "usage": {},
      "details": {
        "readFiles": [],
        "modifiedFiles": []
      }
    },
    "estimatedTokensAfterAtSnapshot": 22000,
    "provenance": {
      "model": {
        "provider": "anthropic",
        "id": "model-id",
        "api": "anthropic-messages",
        "baseUrl": "https://api.example.com",
        "contextWindow": 200000,
        "maxTokens": 16384
      },
      "thinkingLevel": "medium",
      "configFingerprint": "..."
    },
    "createdAt": "2026-01-01T00:00:00.000Z"
  }
}
```

字段规则：

- `version`：checkpoint schema 版本。首个实现只接受 `3`。
- `piVersion`：生成结果的 Pi 版本，必须与运行时 `VERSION` 相同。
- `algorithmVersion`：Pi-press preparation 适配算法版本。
- `summaryFormatVersion`：摘要格式和原生 compact 编排版本。
- `checkpointId`：扩展生成的逻辑唯一标识；不依赖 Pi 自动生成的 custom entry ID。
- `sessionId`：生成 checkpoint 时的 session ID。
- `snapshotLeafId`：生成快照时当前分支的实际叶子 entry ID，用于祖先校验。
- `snapshotSourceLeafId`：忽略所有 `customType` 以 `pi-press.` 开头的状态 entry 后，最新的其他 entry ID。该字段用于 snapshot 去重，只表示生成输入边界，不替代实际叶子。
- `epochCompactionId`：快照分支最近的正式 compaction entry ID；没有时为 `null`。该字段是唯一的持久化 compaction epoch，不再维护整数 generation。
- `snapshotKey`：后台任务去重键，不作为正式 compaction 的相等匹配条件。
- `compaction`：公开 `compact()` 生成的结果。`tokensBefore` 只记录快照值；正式返回时替换为当前 preparation 的值。
- `compaction.firstKeptEntryId`：摘要后保留的第一个 entry ID，必须是 `snapshotLeafId` 的祖先或与其相同；其 entry 类型按 Pi preparation 语义处理。
- `compaction.details`：保留原生 `readFiles` 和 `modifiedFiles`。未知附加字段允许原样持久化。
- `estimatedTokensAfterAtSnapshot`：生成时的预计压缩后 token，仅用于诊断和刷新判断。
- `provenance`：生成模型、thinking level 和配置来源，只用于诊断与去重，不作为消费时的模型相等条件。
- `createdAt`：checkpoint 创建时间。

custom entry 数据必须经过运行时 schema 校验。字符串必须非空，数字必须有限且非负，entry 引用必须存在于当前分支，`usage` 和 `details` 必须是可序列化数据。未知版本或无效数据必须忽略。

checkpoint 不复制原始消息，不可原地更新。原始消息继续由 Pi 的普通 session entry 保存。消费状态由正式 compaction entry 的 `details.piPress.checkpointId` 推导，不额外写入 consumed entry。

## 后台摘要生成

后台任务由 Pi-press 调度，输出必须来自当前 Pi 公开的 `compact()`：

1. 通过 `ctx.sessionManager.getSessionId()`、`getLeafId()` 和 `getBranch()` 读取 `sessionId`、`snapshotLeafId` 与当前分支；不读取 session 文件。
2. 从当前分支找到最近的正式 compaction entry，其 ID 作为 `epochCompactionId`；没有时为 `null`。
3. 忽略所有 `customType` 以 `pi-press.` 开头的状态 entry，找到最新的其他 entry 作为 `snapshotSourceLeafId`，并据此生成 snapshot key。
4. 版本适配模块从分支 entry 构造 `Parameters<typeof compact>[0]`：
   - 按前次正式 compaction 的 `firstKeptEntryId` 确定摘要起点和 `previousSummary`；
   - 使用 `findCutPoint` 选择候选边界；
   - 使用 `sessionEntryToContextMessages` 构造 `messagesToSummarize` 和 `turnPrefixMessages`；
   - 保留 Pi 对 context-visible message、split turn、相邻 metadata 和 tool result 的边界语义；
   - 累计当前摘要范围及前次兼容 details 中的文件操作；
   - 使用快照时的公开 usage 与 `estimateTokens` 计算 `tokensBefore`。
5. `firstKeptEntryId` 视为 preparation 生成的不透明 entry ID。它可以指向 user、assistant、bash execution、custom message、branch summary 或相邻的 context-invisible metadata；禁止自行限定为 user/assistant。
6. 解析摘要请求运行时：
   - 捕获当前活动模型和 thinking level；
   - 调用 `ctx.modelRegistry.getApiKeyAndHeaders(model)` 并检查 `ok`；
   - 保留解析结果中的 `baseUrl`、`apiKey`、`headers` 和 `env`，将值为 `null` 的 header 视为删除并在传给 `compact()` 前移除；
   - 当解析结果包含 `baseUrl` 时创建带该地址的 `requestModel`；
   - 通过 `ctx.modelRegistry.getProvider(model.provider)` 取得有效 provider，并把其 `streamSimple` 适配为 `StreamFn`。
7. 调用包根入口公开的 `compact(preparation, requestModel, apiKey, headers, undefined, signal, thinkingLevel, streamFn, env, retry, callbacks)`。Pi-press 只维护 retry、callbacks、超时和独立 `AbortSignal` 的配置。
8. `compact()` 返回完整的 `summary`、`firstKeptEntryId`、`tokensBefore`、`usage` 和原生 `details`。Pi-press 不再单独调用 `serializeConversation()` 或 `generateSummaryWithUsage()`。
9. 追加前重新读取当前 session 状态，确认当前分支继承 `snapshotLeafId`、最新正式 compaction ID 仍为 `epochCompactionId`，且 preparation 算法和摘要格式版本未变化。
10. 校验通过后调用 `pi.appendEntry("pi-press.precompaction", data)` 追加 checkpoint。

模型、thinking level 或 endpoint 在摘要完成后发生变化，不会单独使已生成摘要失效；这些字段只作为生成来源记录。消费时按当前模型上下文窗口重新计算压缩后 token。Pi 版本、preparation 算法版本或摘要格式版本变化时，结果必须作废。

追加前检查与 `pi.appendEntry()` 之间不保证原子性。正式 compaction 可能在该窗口内插入，产生一条过期 custom checkpoint；该 entry 会被 `epochCompactionId` 校验拒绝，不进入 LLM 上下文，可以保留。

后台任务使用独立的 `AbortController`。`session_shutdown`、分支切换、正式 compaction epoch 变化或 preparation 算法版本变化时中止任务。后台失败、超时或取消后清除 in-flight 状态，并按配置决定同一 snapshot 是否允许重试。

## 正式 compaction 的复用规则

`session_before_compact` 收到 Pi 当前的 `preparation`、`reason`、`willRetry`、`customInstructions` 和事件 `signal` 后，按以下顺序处理：

1. 检查 `precomputeMode`。模式为 `"off"` 时返回空结果。
2. 只处理受支持的事件：`reason: "threshold"`，或模式为 `"threshold-and-manual"` 时无 `customInstructions` 的 `reason: "manual"`。`reason: "overflow"`、`willRetry: true` 或存在 `customInstructions` 时返回空结果。
3. 通过 `ctx.sessionManager.getBranch()` 获取最新分支，并计算当前 `sessionId` 与 `epochCompactionId`。
4. 从当前分支由新到旧扫描 `pi-press.precompaction` entry，依次执行 schema、版本、session 和 epoch 校验。
5. 在当前分支中定位 `snapshotLeafId` 与 `compaction.firstKeptEntryId`。两者必须存在，且 `firstKeptEntryId` 的位置不得晚于 `snapshotLeafId`。entry 类型不限定为 user/assistant。
6. 确认当前分支继承 `snapshotLeafId`。在 Pi append-only session 契约下，这同时证明 snapshot 之前的摘要输入未被替换。
7. 确认 checkpoint 尚未被正式 compaction entry 的 `details.piPress.checkpointId` 引用，也未被当前进程领取。
8. 使用 checkpoint 摘要和 `firstKeptEntryId` 模拟压缩后上下文：
   - 通过公开 `buildSessionContext` 取得当前 active messages，并对其使用 `estimateTokens`；
   - 计算 `fixedOverhead = max(0, currentPreparation.tokensBefore - currentMessagesEstimatedTokens)`，保留系统提示词、工具定义及其他未体现在消息字符数中的估算开销；
   - 以 checkpoint summary 作为 compaction summary；
   - 从当前分支的 `firstKeptEntryId` 开始，通过 `sessionEntryToContextMessages` 收集保留消息；
   - Pi-press custom entry 和其他 context-invisible metadata 不产生消息；
   - `estimatedTokensAfter = fixedOverhead + summaryEstimatedTokens + keptMessagesEstimatedTokens`。
9. 计算容量限制：

```text
safetyMargin = max(4096, ceil(contextWindow * 0.02))
hardLimit = contextWindow - currentPreparation.settings.reserveTokens - safetyMargin
targetLimit = floor(contextWindow * targetPostCompactionPercent / 100)
acceptLimit = min(hardLimit, targetLimit)
```

`estimatedTokensAfter` 必须小于或等于 `acceptLimit`。当前模型、context window 或限制不可用时返回空结果。

10. 找到 ready checkpoint 后立即领取，并中止同 epoch 中不再需要的后台任务。
11. 没有 ready checkpoint 时，查找满足相同 session、epoch、算法版本和祖先条件的 in-flight 任务。snapshot key 无需与当前叶子相等。
12. 在 `hookWaitTimeoutMs` 和事件 `signal` 约束内等待兼容任务。超时或取消时先将任务标记为 discarded、清除当前任务身份，再发送 abort 并返回空结果；成功后重新从步骤 3 开始读取和校验。
13. 同一时间只允许一个 compaction hook 领取 checkpoint。

返回值复用 checkpoint 的摘要、边界、usage 和原生文件 details，但 `tokensBefore` 使用当前 preparation 的值：

```ts
{
  compaction: {
    summary: checkpoint.compaction.summary,
    firstKeptEntryId: checkpoint.compaction.firstKeptEntryId,
    tokensBefore: currentPreparation.tokensBefore,
    usage: checkpoint.compaction.usage,
    details: {
      ...(checkpoint.compaction.details ?? {}),
      readFiles: checkpoint.compaction.details?.readFiles ?? [],
      modifiedFiles: checkpoint.compaction.details?.modifiedFiles ?? [],
      piPress: {
        version: checkpoint.version,
        piVersion: checkpoint.piVersion,
        algorithmVersion: checkpoint.algorithmVersion,
        checkpointId: checkpoint.checkpointId,
        snapshotLeafId: checkpoint.snapshotLeafId
      }
    }
  }
}
```

原生 `readFiles`/`modifiedFiles` 保持在 details 顶层，Pi-press 溯源信息放在 `details.piPress`。checkpoint summary 已由公开 `compact()` 附加对应文件标签，因此下一轮 Pi-press compaction 或回退到原生 compaction 时仍保留文件上下文。

Pi 随后追加正式 `compaction` entry。恢复后的上下文为：

```text
正式 compaction summary
+ firstKeptEntryId 开始的 context-visible 消息
+ 正式 compaction entry 之后的新消息
```

`session_compact` 收到正式 entry 后读取 `details.piPress.checkpointId`，完成进程内消费记录并中止旧 epoch 的任务。正式 compaction entry 本身是持久化消费记录；session 重启时通过公开 SessionManager entry 恢复，无需额外 custom consumed entry。

## 检查点失效和后备处理

以下情况使 checkpoint 不可消费：

- 当前 checkpoint 的 Pi 版本、checkpoint schema、preparation 算法版本或摘要格式版本与运行时不匹配；
- 当前 `precomputeMode` 不允许对应 compaction 类型；
- `reason` 为 `overflow`、`willRetry` 为真或存在 `customInstructions`；
- 当前 session 与 checkpoint session 不同；
- 当前分支不继承 `snapshotLeafId`；
- `firstKeptEntryId` 不在当前分支中，或位于 `snapshotLeafId` 之后；
- 当前最新正式 compaction ID 与 `epochCompactionId` 不同；
- summary 为空，usage/details 数据无效，或 entry 引用损坏；
- checkpoint 已被正式 compaction 消费或已被当前 hook 领取；
- 当前模型的 context window 不可用；
- `estimatedTokensAfter` 超过当前容量限制；
- 等待 in-flight 任务超时或被事件 signal 取消。

模型、thinking level、provider endpoint 或生成预算变化本身不会使已有摘要失效；这些变化只影响新任务去重和当前容量计算。

checkpoint 不可消费时，扩展返回空结果，由 Pi 原生 compaction 生成摘要。原始 session entry 保持完整。

正式 compaction 与后台任务竞争时，正式 compaction 优先：

1. ready checkpoint 被领取后，中止同 epoch 中不再需要的后台任务。
2. 兼容任务仍在生成时，hook 最多等待 `hookWaitTimeoutMs`。
3. 等待失败时先将任务标记为 discarded 并清除当前任务身份，再发送 abort 和返回空结果供 Pi 生成原生摘要。
4. Pi 写入正式 compaction 后，epoch ID 变化；旧任务即使完成，也无法通过追加前校验。

后台任务在摘要完成后、custom entry 追加前退出时不会产生 ready checkpoint。JSONL 已追加但进程随后退出时，session 恢复会通过公开 `getEntries()`/`getBranch()` 重新判断有效性。

## 分支和生命周期处理

后台任务快照记录：

- `sessionId`；
- 实际 `snapshotLeafId`；
- 用于去重的 `snapshotSourceLeafId`；
- `compaction.firstKeptEntryId`；
- `epochCompactionId`；
- Pi、preparation 算法和摘要格式版本；
- snapshot key 与生成来源。

追加前必须满足：

```text
当前 sessionId == snapshot sessionId
当前分支包含 snapshotLeafId
当前分支包含 firstKeptEntryId
firstKeptEntryId 位于 snapshotLeafId 之前或与其相同
当前最新正式 compaction ID == snapshot epochCompactionId
当前 checkpoint 的 Pi 版本、算法版本和摘要格式版本仍满足消费校验
```

当前分支仅在快照后追加新 entry 时，checkpoint 仍然有效，新消息作为未压缩尾部保留。切换到其他分支时中止当前后台任务并清除分支内存状态；旧分支已持久化的 checkpoint 保留。再次导航回旧分支时，只要祖先、epoch 和容量校验通过，该 checkpoint 可以恢复使用。

custom checkpoint 和 metrics entry 会成为 session tree 中的新 leaf，但不会转换为 LLM 消息。后续 snapshot 将所有 `customType` 以 `pi-press.` 开头的 entry 视为持久化 metadata：实际叶子仍记录在 `snapshotLeafId`，去重边界使用最新的其他 entry。

生命周期事件处理：

- `session_start`：通过 `ctx.sessionManager.getEntries()` 和 `getBranch()` 恢复当前分支 checkpoint、正式 compaction epoch 与消费记录。
- `session_before_tree`：递增内存 `runEpoch` 并中止当前任务，确保任务不能在分支切换期间追加 entry。
- `session_tree`：按新分支恢复状态；不重复递增已经由 `session_before_tree` 更新的 `runEpoch`。
- `session_shutdown`：递增 `runEpoch`，中止任务并清除 session-bound 引用；处理器不等待后台 provider Promise，后台闭包不得再访问失效的 `pi` 或 `ctx`。
- `session_compact`：记录消费，递增 `runEpoch`，中止旧 epoch 任务并以新正式 compaction ID 开始下一轮。
- `model_select` 和 `thinking_level_select`：只更新后续任务的生成来源，不改变内容 snapshot key，也不废弃已持久化 ready checkpoint。

## 运行时状态与并发

Runtime 维护以下最小状态：

```text
sessionId
runEpoch
inFlightTask
compactionHookInFlight
claimedCheckpointId
lastAttemptBySnapshotKey
lastError
metrics
```

`inFlightTask` 至少包含：

```text
snapshotKey
sessionId
epochCompactionId
snapshotLeafId
snapshotSourceLeafId
runEpoch
AbortController
Promise
```

状态规则：

- 同一 session、正式 compaction epoch 和 snapshot key 只允许一个后台任务。
- 同一时间只允许一个后台摘要请求和一个 compaction hook。
- 每个异步阶段完成后先比较捕获的 `runEpoch` 和当前 `inFlightTask` 身份；任一不一致时停止，且不得读取失效的 session-bound 对象或追加 entry。
- `session_before_tree`、`session_shutdown` 和 `session_compact` 递增 `runEpoch` 并中止当前任务；`session_tree` 只恢复新分支状态。
- 任何超时、取消或主动废弃操作都必须先清除任务身份，再发送 abort。即使 provider 忽略取消，旧 Promise 也不能通过追加前检查。
- `session_before_compact` 领取 checkpoint 后设置 `claimedCheckpointId`；失败或事件取消时释放，成功后由 `session_compact` 确认消费。
- 成功生成 ready checkpoint 后，同一 snapshot key 不再发起请求；明确失败时按 retry/cooldown 配置决定是否重试。
- 刷新任务受 `maxRefreshesPerEpoch` 限制，并且必须使用新的 `snapshotSourceLeafId`。
- 所有状态检查发生在 `pi.appendEntry()` 前；检查通过后立即同步追加 custom entry。
- 正式 compaction epoch 只由当前分支最新正式 compaction entry ID 表示，不维护额外整数 generation。

## 费用和诊断

预压缩请求会产生独立 provider usage。ready checkpoint 的 usage 持久化在 checkpoint 中；被正式 compaction 消费后，同一 usage 写入正式 compaction entry，由 Pi session stats 统计一次。

未消费或追加前失效的请求不会进入 Pi 原生 session stats。Pi-press 必须单独统计：

- 启动、成功、失败、取消、ready、消费和废弃次数；
- ready 命中率、原生回退次数和 hook 等待时间；
- consumed usage 与 discarded usage；
- 生成时和消费时的 `estimatedTokensAfter`；
- 后台请求期间的前台请求耗时与 provider 限流错误；
- 每个 epoch 的刷新次数。

诊断默认保存在内存中。需要跨重启统计时，按批次通过 `pi.appendEntry("pi-press.metrics", data)` 持久化聚合值；metrics custom entry 不进入 LLM 上下文。usage 从 checkpoint 转入正式 compaction 后，Pi-press 报告必须标记为 consumed，禁止与 Pi session stats 相加后声称为新的额外费用。

## 验证范围

### 发布包接口与版本适配

测试以当前安装的 `@earendil-works/pi-coding-agent` 发布包为对象，最低依赖版本为 `0.84.1`：

- 生产代码只从包根入口导入，构建测试阻止 `dist/core/...` 深层导入；
- 不通过 `VERSION` 做全局启用门控；当前版本会写入 checkpoint，版本不兼容产生的运行时错误通过 CLI 通知显示，并回退 Pi 原生 compaction；
- 使用公开 SDK、`SessionManager`、模拟 provider 和测试扩展创建固定 session fixture；
- 通过公开 `session_before_compact` 捕获 Pi 生成的 `preparation`，与版本适配模块对同一分支生成的结果比较；测试不得导入内部 `prepareCompaction()`；
- 比较 `firstKeptEntryId`、`messagesToSummarize`、`turnPrefixMessages`、`isSplitTurn`、`previousSummary`、file operations、settings 和 `tokensBefore`；
- 覆盖首次 compaction、连续 compaction、缺失旧 `firstKeptEntryId` 的后备语义、branch summary、custom message、Pi-press custom entry、label/model/thinking metadata 和损坏 entry 引用；
- 覆盖 user、assistant、bash execution、custom message、branch summary 和相邻 context-invisible metadata 作为保留边界，以及 tool result 不成为有效切分点。

### 原生 compact 与 provider

- 版本适配模块生成的 preparation 传给公开 `compact()` 后，验证原生摘要格式、`previousSummary` 更新和文件标签；
- split turn 产生正确的历史摘要与 turn-prefix 摘要，调用次数和合并 usage 正确；
- `details.readFiles`/`modifiedFiles` 与摘要中的 XML 文件标签一致；
- `getApiKeyAndHeaders()` 的 `ok: false`、`baseUrl`、`apiKey`、可删除 header、`env` 均有测试；
- 有效 provider 的 `streamSimple` 适配器支持内置 provider、配置覆盖 endpoint 和扩展 provider；
- 后台请求的 retry、总超时、AbortSignal 和 provider 错误均能释放 in-flight 状态；
- 摘要完成后模型或 thinking level 变化时，ready checkpoint 保留，消费容量按当前模型重新计算。

### Checkpoint 与 Pi 扩展

- `turn_end` 处理器在延迟摘要 Promise 未完成时已经返回，证明后台请求未阻塞 agent 事件；
- `ctx.getContextUsage()` 无可用值时不启动任务；从低于阈值到跨越阈值时只启动一次；
- checkpoint v3 schema、未知版本、非有限数字、空 summary、无效 usage/details 和损坏 entry 引用均有验证；
- `pi.appendEntry()` 写入的 checkpoint 和 metrics custom entry 不进入 LLM 上下文；
- ready checkpoint 返回兼容 `CompactionResult`，并使用当前 preparation 的 `tokensBefore`；
- 正式 compaction details 同时保留 `readFiles`、`modifiedFiles` 和 `piPress`；
- Pi 写入正式 compaction 后能够正确重建上下文，后续 Pi-press compaction 与原生回退均保留文件上下文；
- session 重启后通过 `getEntries()`/`getBranch()` 恢复 ready checkpoint、epoch 和消费状态，不读取 JSONL 文件；
- snapshot key 只用于去重；当前叶子变化后，祖先兼容的 ready 或 in-flight checkpoint 仍可消费；
- 模拟压缩后的 token 包含从当前 preparation 推导的 fixed overhead；超过 hard limit 或 target limit 时返回空结果。

### 并发和生命周期

至少覆盖：

- 后台摘要完成后再触发 threshold compaction；
- threshold compaction 开始时后台任务仍在生成，并在等待时间内完成；
- hook 等待超时后中止后台任务，随后只剩 Pi 原生摘要请求；
- ready checkpoint 被领取时中止同 epoch 的其他后台任务；
- 正式 compaction 先发生，旧 epoch 任务随后完成但不能追加 checkpoint；
- `session_before_tree` 中止任务，`session_tree` 恢复新分支，返回旧分支后恢复持久化 checkpoint；
- `session_shutdown` 和 reload 后旧后台闭包不访问失效的 `pi`/`ctx`，shutdown handler 不等待延迟 provider Promise；
- `model_select` 和 `thinking_level_select` 更新后续任务 provenance，但不改变内容 snapshot key，也不废弃 ready checkpoint；
- 同一 snapshot key 去重、明确失败后的受控重试和每 epoch 最多一次刷新；
- `precomputeMode` 三种取值及运行中切换到 `"off"`；
- manual `/compact`、`customInstructions`、所有 overflow compaction 和 `willRetry` 均按支持范围复用或回退；
- consumed usage 进入正式 compaction 一次，discarded usage 只进入 Pi-press 诊断统计。

## 验收标准

1. 当前安装的 Pi 版本尝试执行预压缩；公开 API 不兼容、provider、超时或结果校验失败时通过 CLI 显示错误，并由 Pi 原生 compaction 继续处理。
2. 上下文使用量跨越默认 80% 软阈值后调度 detached task，`turn_end` 不等待摘要请求，当前 agent 不被中止。
3. `ctx.getContextUsage()` 返回不可用值时不启动任务，也不读取 session 文件自行估算。
4. 生产代码只使用 Pi 扩展契约和包根入口；唯一自有协议适配集中在 preparation 版本适配模块。
5. 版本适配模块与当前 Pi 公开事件提供的 preparation 在目标 fixture 上一致，包括 split turn、metadata 边界、前次摘要和文件操作。
6. 后台摘要调用公开 `compact()`，保留原生提示词、`previousSummary`、split turn、usage 和文件上下文语义。
7. 模型请求使用有效 provider，并保留解析后的 `baseUrl`、`apiKey`、headers 和 `env`；认证失败时安全回退。
8. checkpoint 以 `pi-press.precompaction` v3 custom entry 持久化，不进入 LLM 上下文，也不复制原始消息。
9. ready checkpoint 可在不发起第二次摘要请求的情况下完成 threshold compaction。
10. 当前叶子晚于 snapshot 时，祖先兼容的 checkpoint 仍可使用；snapshot key 不作为消费相等条件。
11. compatible in-flight checkpoint 在等待时间内完成时可以消费；超时后任务被中止，Pi 原生摘要正常执行。
12. 消费前模拟的 `estimatedTokensAfter` 同时满足 hard limit、目标比例和安全余量；超限时回退原生 compaction。
13. 正式 compaction entry 由 Pi 写入，包含 checkpoint summary、边界、当前 `tokensBefore`、usage、原生文件 details 和 `details.piPress`。
14. 正式 compaction 后，上下文包含摘要以及 `firstKeptEntryId` 之后的 context-visible 消息；`firstKeptEntryId` 可以是 Pi 允许的 metadata 边界。
15. session 重启、分支切换和返回旧分支后，checkpoint 与消费状态均通过公开 SessionManager 接口正确恢复。
16. 正式 compaction ID 是唯一持久化 epoch；旧 epoch 后台结果无法追加或复用，不存在整数 compaction generation 状态。
17. `customInstructions`、所有 overflow 事件和 `willRetry: true` 均回退 Pi 原生实现；手动复用仅在配置允许且没有自定义指令时发生。
18. 模型、thinking level 或 endpoint 变化不自动废弃摘要；当前 context window 无法容纳候选结果时仍会拒绝消费。
19. 同一 snapshot 不并发生成重复摘要，每个 epoch 的刷新次数受限，session-bound 对象失效后不会被后台闭包访问。
20. Pi-press 能区分 consumed usage 与 discarded usage；正式 compaction usage 不重复计费，未消费费用在诊断中明确记录。
21. Pi-press 能区分 consumed usage 与 discarded usage；正式 compaction usage 不重复计费，未消费费用在诊断中明确记录；后台预压缩和正式 compaction 的成功/失败状态通过 CLI 通知显示。
22. `npm run typecheck` 和 `npm test` 通过，并包含上述版本适配、provider、checkpoint、并发、生命周期和原生回退测试。
