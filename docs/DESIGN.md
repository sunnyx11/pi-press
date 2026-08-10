# pi-press 预压缩、虚拟压缩与持久化设计

## 目的

`pi-press` 用于改善 Pi 原生上下文压缩的等待体验，同时保持 Pi 原生会话格式和上下文语义。

核心目标：

- 上下文使用量达到约 80% 时，在后台提前生成一份预压缩结果。
- 后台任务执行期间，当前 agent 继续运行，不中止当前操作。
- 预压缩结果持久化到当前 session 的 JSONL 文件。
- checkpoint ready 后，在每次 provider 请求前通过 `context` 事件生成“预压缩摘要 + 当前未压缩尾部”的虚拟压缩上下文，避免同一 agent 运行中的连续工具调用使请求超过上下文窗口。
- 虚拟压缩只替换当次请求的消息副本，不修改 Pi 的 session entry 或 `agent.state.messages`。
- Pi 原生自动压缩尚未产生正式 entry 时，在 `agent_settled` 后通过 `ctx.compact()` 发起一次宿主管理的正式压缩，并复用已经生成的 checkpoint。
- 正式 `compaction` entry、agent 上下文重建、恢复、分支和 TUI 行为继续使用 Pi 的实现。

Pi-press 自行实现并维护以下内容：

- checkpoint 的调度、持久化、校验、去重、消费和失效；
- 虚拟压缩的请求级上下文构造、容量检查和生效状态；
- `agent_settled` 后正式压缩的调度、幂等控制和失败恢复；
- 后台任务的超时、取消与并发控制；
- 当前 Pi 公开 preparation 接口缺少的窄版本适配模块。

实现按接口稳定性分为三层：

1. 首选 Pi 扩展契约：`context`、`turn_end`、`agent_settled`、`session_before_compact`、`session_compact`、`session_shutdown`、`session_before_tree`、`session_tree`、`pi.appendEntry()`、`ctx.getContextUsage()`、`ctx.isIdle()`、`ctx.compact()`、`ctx.sessionManager` 和 `ctx.modelRegistry`。
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
- 通过 `context` 事件修改 Pi 内部 transcript、原始 session entry 或历史 usage；该事件只返回当次 provider 请求使用的消息副本。
- 在 `turn_end` 或 `agent_end` 期间调用 `ctx.compact()` 并中止仍在处理的 agent。
- 维护项目级事实文档。
- 删除或重写原始 session entry。
- 手动写入 Pi 的正式 `type: "compaction"` entry；正式 entry 由 Pi 根据扩展返回的 `CompactionResult` 写入。

## 兼容范围

- npm 发布包将 `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai` 和 `@earendil-works/pi-coding-agent` 声明为 `peerDependencies: "*"`，由 Pi 宿主提供运行时核心包；开发依赖使用 `>=0.84.1`，当前最低兼容版本仍为 `0.84.1`。
- 当前包根 `VERSION` 写入 checkpoint provenance，并用于拒绝复用其他 Pi 版本生成的 checkpoint。版本升级后会生成新的 checkpoint。
- 公开 API、provider、超时、结果校验或 checkpoint 追加失败时，通过 CLI error 通知显示错误；虚拟转换返回事件原消息，正式 hook 返回空结果并由 Pi 原生流程继续处理。preparation 不可用时只记录诊断并静默跳过；生成或消费阶段容量不满足目标、hook 等待超时时，通过 CLI warning 通知显示跳过原因和原生后备处理状态。
- 所有运行时导入必须来自包根入口，禁止通过 `dist/core/...` 引用深层模块。
- 目标契约包括 coding-agent 的 `context`、`agent_settled`、compaction 扩展事件、`ctx.compact()`、`CompactionResult`、公开 SessionManager 读取接口、custom entry 和上下文重建规则。
- `@earendil-works/pi-agent-core` harness 使用不同的 compaction 契约，不属于本设计的目标实现。
- `ctx.compact()` 不返回 Promise，`session_before_compact` 也不提供调用方 request ID。扩展通过调用前设置的 `pendingFormalization`、当前 session、epoch 和 checkpoint ID 识别内部 manual 请求；request ID 只用于扩展自己的延迟回调和完成回调。其他扩展在同一空闲区间并发调用 manual compaction 时，公开 API 无法提供跨扩展原子互斥，最终以 Pi 发出的 `session_compact` 和最新 epoch 为准。
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
每次 provider 请求前触发 context
        |
        +-- checkpoint 未 ready 或校验失败 --> 保持原消息
        |
        `-- checkpoint ready --> 返回虚拟 compaction summary + 当前保留尾部
                                      |
                                      v
                              provider 只接收虚拟压缩上下文
                                      |
                                      v
                        后续 assistant/toolResult 仍写入原始 session
                                      |
                                      v
                agent_end 后由 Pi 先执行自动重试和原生压缩检查
                                      |
                  +-------------------+-------------------+
                  |                                       |
          Pi 已写入正式 compaction                 Pi 未写入正式 compaction
                  |                                       |
                  v                                       v
        session_compact 清除虚拟状态             agent_settled 且 ctx.isIdle()
                                                          |
                                                          v
                                      Pi-press 调用 ctx.compact()
                                                          |
                                                          v
                                      session_before_compact(reason: manual)
                                                          |
                                                          v
                                      Pi-press 返回 checkpoint 结果
                                                          |
                                                          v
                                      Pi 追加正式 compaction entry
                                      并重建 agent.state.messages
```

软阈值阶段生成并保存 checkpoint，不中止当前 agent。checkpoint ready 后，`context` 处理器将其投影为请求级 `compactionSummary`，并追加 `firstKeptEntryId` 开始的当前 context-visible 消息。该转换在每次 LLM 调用前重新计算，因此 checkpoint 之后新增的 assistant 消息和工具结果会进入未压缩尾部。

虚拟压缩不修改 `agent.state.messages`，也不追加正式 session entry。Pi 的内部 transcript 和 JSONL 在当前 agent 运行期间仍保留原始消息；只有发送给 provider 的消息副本发生变化。provider 返回的 usage 因而反映虚拟压缩后的请求大小，不能据此保证 Pi 原生阈值一定生成正式 compaction。

checkpoint 是扩展 custom entry，默认不进入 LLM 上下文。Pi-press 只在 `context` 返回值中使用其摘要；最终生效的 `type: "compaction"` entry 仍由 Pi 写入。Pi 原生压缩优先；如果原生检查没有写入正式 entry，Pi-press 才在 `agent_settled` 后调用 `ctx.compact()`。正式压缩完成后，session 恢复、分支和 TUI 继续使用 Pi 的实现。

如果后台 checkpoint 未完成、已失效或当前虚拟上下文超过安全容量，`context` 返回原消息并记录诊断；如果正式 compaction 时 checkpoint 不可复用，`session_before_compact` 返回空结果，由 Pi 使用原生摘要流程。

## 触发规则

### 后台预压缩

- 监听 `turn_end`，只同步读取使用量、创建快照和调度任务。处理器不得等待摘要 Promise，必须立即返回。
- detached task 必须由调度器保存 Promise，并设置统一错误处理，禁止产生未处理的 Promise rejection。
- 只使用 `ctx.getContextUsage()` 判断首次预压缩阈值。返回 `undefined`、`tokens: null` 或 `percent: null` 时跳过本次首次检查，不自行估算系统提示词和工具定义占用。虚拟压缩已经应用后，刷新判断改用 checkpoint 容量估算，避免 provider usage 只反映虚拟消息时遗漏尾部增长。
- 默认软阈值为活动模型上下文窗口的 80%。该值是最早启动点，不是复用 checkpoint 的充分条件。
- 达到阈值但当前分支无法构造可用 preparation 时，记录诊断并静默跳过；后续 `turn_end` 可以再次尝试。
- checkpoint 只有在 `pi.appendEntry()` 成功返回后才能显示预压缩成功；生成失败、超时或追加失败显示 CLI error，生成阶段容量不足显示 CLI warning。
- Pi-press 通过 `precomputeMode: "off" | "threshold" | "threshold-and-manual"` 明确控制是否生成和消费检查点，默认值为 `"threshold"`。当前公开扩展接口无法查询 Pi 的 auto-compaction 设置，因此不得读取 settings 文件推断运行时状态。
- 同一 session、同一正式 compaction epoch 和同一 snapshot key 同时只运行一个后台任务。
- snapshot key 由 session ID、正式 compaction epoch、`snapshotSourceLeafId`、Pi 版本、preparation 算法版本、摘要格式版本和 preparation 配置 fingerprint 组成，只用于后台去重。生成模型和 thinking level 只写入 provenance，不参与该键。
- 后台任务不会调用 `ctx.compact()`，避免中止当前 agent 操作。
- 任务使用独立的 `AbortController`，不复用当前 agent 的请求信号。
- 宿主进程内所有 `ExtensionRuntime` 模块实例同一时间最多执行一个后台操作。活动操作覆盖 preparation、认证和 provider 摘要；任务超时、实例失效或扩展 reload 后，底层 Promise 尚未结束时继续占用名额。
- 同一正式 compaction epoch 最多刷新一次 checkpoint。虚拟上下文预计大小超过 `targetPostCompactionPercent` 后，由后续 `turn_end` 调度刷新；该判断不要求重新达到首次 80% 软阈值。

### 虚拟 compaction

- `context` 在每次 provider 请求前执行，输入是 Pi 为扩展创建的消息副本；返回值只影响该次请求。
- 每次事件都重新读取当前 branch、正式 compaction epoch 和 ready checkpoint，不长期复用已经构造的消息数组。
- checkpoint 必须通过 schema、Pi 版本、session、epoch、祖先、消费状态和当前模型容量校验。
- 虚拟上下文由一个 `role: "compactionSummary"` 消息和 `firstKeptEntryId` 开始的当前 context-visible 消息组成，使用 Pi 的公开 entry-to-message 语义构造。
- 新增 assistant 消息、工具结果、steering 消息和 follow-up 消息在下一次 `context` 事件中进入当前尾部，不修改 checkpoint 摘要。
- 虚拟转换不得修改 `event.messages`、`agent.state.messages` 或 SessionManager 返回的数据；必须返回新数组和新建的摘要消息。
- 候选压缩后大小超过 `targetPostCompactionPercent` 时可以继续使用已有虚拟上下文，但必须请求 checkpoint 刷新；超过 hard limit 时不得将该候选标记为已应用，并记录保护能力不足的诊断。
- `context` 与其他扩展按注册顺序串行执行。Pi-press 必须证明当前事件消息与 SessionManager 派生的边界能够无歧义对应；无法保留其他扩展的上下文变换时返回事件原消息，禁止静默丢弃其他扩展注入的消息。
- checkpoint 首次成功用于请求时记录 `virtualCheckpointId`、session ID 和 epoch。后续每次成功应用更新使用状态，供 `agent_settled` 判断是否需要正式持久化。
- 正式 compaction entry 出现、session 或分支变化、checkpoint 失效以及 `precomputeMode: "off"` 时立即停止应用旧虚拟状态。

### 正式 compaction

- Pi 在 `agent_end` 后执行自动重试和原生 compaction 检查，原生正式压缩始终优先。
- 扩展不得在 `turn_end` 调用 `ctx.compact()`；此时 agent loop 仍可能继续采样，调用会中止当前操作。
- 扩展不得在 `agent_end` 调用 `ctx.compact()`；该事件之后仍可能发生自动重试、原生压缩或排队消息续跑。
- 只有 `agent_settled` 表示本轮 session 级运行已经结束。存在已实际应用的虚拟 checkpoint、尚无同 epoch 正式 compaction、没有 pending 正式化请求且 `ctx.isIdle()` 为真时，扩展才调度 `ctx.compact()`。
- 调度回调必须在当前 `agent_settled` handler 返回后执行，并在调用前重新校验 session、branch、epoch、checkpoint 和 `ctx.isIdle()`，避免与其他扩展在同一事件中启动的新 agent 运行竞争。
- `ctx.compact()` 是 fire-and-forget API。扩展设置 `pendingFormalization` 后调用一次，并通过 `session_compact`、`onComplete` 和 `onError` 管理完成状态，禁止将其包装为 handler 内等待的 Promise。
- 扩展自行发起的调用不传 `customInstructions`，其 `session_before_compact` 事件为 `reason: "manual"`。该事件通过 `pendingFormalization` 身份允许复用指定 checkpoint，不要求默认模式改为 `"threshold-and-manual"`。
- 使用者发起的 `/compact` 继续遵守 `precomputeMode`：只有 `"threshold-and-manual"` 且没有 `customInstructions` 时复用 checkpoint。
- `reason: "overflow"` 或 `willRetry: true` 一律返回空结果，由 Pi 原生实现处理。
- ready checkpoint 按祖先兼容关系选择，不要求 snapshot key 与当前叶子相同；内部正式化请求必须额外匹配记录的 checkpoint ID、session 和 epoch。
- 如果兼容后台任务仍在生成，hook 可以在配置时间内等待；超时后中止任务并回退 Pi 原生摘要。
- checkpoint 不可复用时返回空结果，`ctx.compact()` 仍由 Pi 原生摘要完成正式压缩。正式 entry 成功写入后，`session_compact` 清除虚拟状态和 pending 状态。
- `onError` 清除 pending 状态并保留仍有效的虚拟 checkpoint；同一 Runtime 实例、session 和 epoch 的下一次 `agent_settled` 最多再尝试一次。

## 配置契约

Pi-press 配置独立于 Pi 的运行时 settings。配置文件按全局到项目的顺序合并：全局文件为 `getAgentDir()/pi-press.json`，项目文件为 `cwd/CONFIG_DIR_NAME/pi-press.json`；项目中存在的字段覆盖同名全局字段，缺失字段继承全局值，最后使用默认值补全。配置文件无法读取、无法解析或根值不是对象时记录诊断，该配置层不提供字段，已读取的较低优先级配置继续生效。两个配置位置解析为同一文件时只读取一次。

`"threshold"` 模式生成 checkpoint、应用虚拟压缩，并在虚拟压缩实际用于 provider 请求后，于 `agent_settled` 发起宿主管理的正式压缩。该正式化不依赖 Pi auto-compaction 是否启用。`"threshold-and-manual"` 在此基础上还允许使用者发起的无自定义指令 `/compact` 复用 checkpoint。当前公开接口无法可靠查询 Pi auto-compaction 设置，实现不得读取 settings 文件推断。当前设计使用以下字段：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `precomputeMode` | `"threshold"` | `"off"` 停用；`"threshold"` 启用预压缩、虚拟压缩和 agent settled 后正式化；`"threshold-and-manual"` 还允许无自定义指令的使用者手动 compaction 复用 checkpoint |
| `softThresholdPercent` | `80` | 最早启动后台任务的上下文百分比 |
| `summaryReserveTokens` | `16384` | 传给候选 preparation 的摘要输出预算，默认取当前 Pi 的 `DEFAULT_COMPACTION_SETTINGS` |
| `taskTimeoutMs` | `300000` | 单次后台任务总超时 |
| `hookWaitTimeoutMs` | `1000` | 正式 compaction 等待兼容 in-flight 任务的最长时间 |
| `targetPostCompactionPercent` | `60` | 正式复用 checkpoint 的最大上下文比例，也是虚拟上下文请求刷新 checkpoint 的目标比例 |

候选 preparation 固定使用 `keepRecentTokens: 2000`，用于在预压缩 checkpoint 中保留少量近期内容，同时覆盖 snapshot 前尽可能多的完整消息；后台摘要请求固定允许一次瞬时错误重试；同一正式 compaction epoch 最多刷新一次 checkpoint。虚拟上下文超过目标比例时仍可在 hard limit 内继续使用，但只允许一次刷新；刷新后仍超过 hard limit 时按保护能力不足处理。这些值都不是配置项。

压缩后 token 校验额外预留 `max(4096, ceil(contextWindow * 0.02))` 的安全余量。实现必须校验百分比、token 和超时字段的范围；`taskTimeoutMs` 与 `hookWaitTimeoutMs` 必须是 `1..2147483647` 范围内的整数，无效字段使用默认值并记录诊断。

配置 fingerprint 参与 snapshot key，防止同一内容在不同生成配置下错误去重。已生成 checkpoint 不因模型、thinking level 或预算配置变化自动失效；虚拟应用和正式消费时均按当前模型重新校验容量。`precomputeMode` 变为 `"off"` 时中止 in-flight 任务、取消尚未发起的正式化调度、清除虚拟状态并停止消费 ready checkpoint；已经交给 Pi 的正式 compaction 由宿主继续完成。

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
    "snapshotKey": "session-1:null:entry-41:current-pi-version:1:1:config",
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
- `provenance`：生成模型、thinking level、实际 request endpoint 和配置来源，只用于诊断，不作为消费时的模型相等条件。endpoint 持久化前必须移除 URL username、password、query 和 fragment。
- `createdAt`：checkpoint 创建时间。

custom entry 数据在追加前和恢复读取时都必须经过完整运行时 schema 校验。字符串必须非空，数字必须有限且非负，entry 引用必须存在于当前分支，`usage` 和 `details` 必须是可序列化数据。JSON 值校验最多访问 100000 个值，嵌套深度最多为 100；超过限制的数据视为无效。未知版本或无效数据必须忽略。

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
   - 当解析结果包含 `baseUrl` 时创建带该地址的 `requestModel`；checkpoint provenance 使用该实际地址的脱敏副本，移除 URL username、password、query 和 fragment；
   - 通过 `ctx.modelRegistry.getProvider(model.provider)` 取得有效 provider，并把其 `streamSimple` 适配为 `StreamFn`。
7. 调用包根入口公开的 `compact(preparation, requestModel, apiKey, headers, undefined, signal, thinkingLevel, streamFn, env, retry, callbacks)`。Pi-press 只维护 retry、callbacks、超时和独立 `AbortSignal` 的配置。
8. `compact()` 返回完整的 `summary`、`firstKeptEntryId`、`tokensBefore`、`usage` 和原生 `details`。Pi-press 不再单独调用 `serializeConversation()` 或 `generateSummaryWithUsage()`。
9. 追加前重新读取当前 session 状态，确认当前分支继承 `snapshotLeafId`、最新正式 compaction ID 仍为 `epochCompactionId`，且 preparation 算法和摘要格式版本未变化。
10. 完成容量估算并写入 `estimatedTokensAfterAtSnapshot` 后，通过统一 v3 parser 校验整个 checkpoint；任一字段无效时丢弃结果并回退。
11. 校验通过后调用 `pi.appendEntry("pi-press.precompaction", data)` 追加 checkpoint。

模型、thinking level 或 endpoint 在摘要完成后发生变化，不会单独使已生成摘要失效；这些字段只作为生成来源记录。消费时按当前模型上下文窗口重新计算压缩后 token。Pi 版本、preparation 算法版本或摘要格式版本变化时，结果必须作废。

追加前检查与 `pi.appendEntry()` 之间不保证原子性。正式 compaction 可能在该窗口内插入，产生一条过期 custom checkpoint；该 entry 会被 `epochCompactionId` 校验拒绝，不进入 LLM 上下文，可以保留。

后台任务使用独立的 `AbortController`，`taskTimeoutMs` 从任务开始时计时，并覆盖 preparation、认证解析和 provider 摘要请求。`session_shutdown`、分支切换、正式 compaction epoch 变化或 preparation 算法版本变化时中止任务。后台失败、超时或取消后清除实例内 in-flight 状态，并按配置决定同一 snapshot 是否允许重试。进程级活动操作只在实际 preparation、认证或 provider Promise 结束后释放；认证或 provider 忽略取消时，reload 后重新导入的扩展实例也不得启动重叠请求。

## 虚拟 compaction 的上下文构造

`context` 事件收到的是扩展 runner 对当前 `AgentMessage[]` 创建的深拷贝。Pi-press 按以下步骤构造返回值：

1. 将 `event.messages` 视为当前事件的权威输入；不得原地修改数组或消息对象。
2. 重新读取 `ctx.sessionManager.getBranch()`，计算 session ID 和最新正式 compaction entry ID。已有正式 compaction 使 epoch 变化时，旧 checkpoint 立即失效。
3. 按正式复用规则扫描 ready checkpoint，但不领取候选。虚拟应用可以并发读取同一不可变 checkpoint；正式 compaction 才需要 claim。
4. 在当前分支中定位 `firstKeptEntryId` 和 `snapshotLeafId`，使用 `sessionEntryToContextMessages()` 推导从保留边界到当前叶子的原生消息序列。
5. 构造仅存在于返回数组中的合成 compaction entry，并通过 `sessionEntryToContextMessages()` 取得 `role: "compactionSummary"` 消息。合成 entry 使用 checkpoint 的 summary、`firstKeptEntryId`、`tokensBefore`、details 和 checkpoint 创建时间，不调用 `pi.appendEntry()`。
6. 将 branch 派生的原生消息按角色、时间戳和角色特有稳定元数据与 `event.messages` 对应；前置 `context` handler 可以转换消息内容。最早和最晚子序列匹配必须产生同一组位置，以证明原生消息和保留边界能够无歧义映射。返回数组必须包含合成摘要、边界后的全部原生消息，以及能够保持顺序的其他扩展注入消息。消息被过滤、重排或替换，或者稳定元数据碰撞导致映射不唯一时，返回 `event.messages`。
7. 估算当前虚拟上下文容量：

```text
additionalMessageTokens = 未被快照估算覆盖的注入消息和 snapshotLeafId 后新增消息的估算值
transformedGrowthTokens = 快照内保留消息转换后的正向 token 差额
estimatedVirtualTokens = estimatedTokensAfterAtSnapshot
  + additionalMessageTokens
  + transformedGrowthTokens
safetyMargin = max(4096, ceil(contextWindow * 0.02))
hardLimit = contextWindow - summaryReserveTokens - safetyMargin
targetLimit = floor(contextWindow * targetPostCompactionPercent / 100)
```

消息转换后 token 减少时不从快照估算中扣减；任一消息无法估算时返回 `event.messages`。

8. `estimatedVirtualTokens <= targetLimit` 时应用候选；大于 target limit 但不超过 hard limit 时继续应用，并在后续 `turn_end` 请求刷新 checkpoint。超过 hard limit 时先在 `hookWaitTimeoutMs` 内等待已经存在的兼容刷新任务；仍无可用候选时返回事件原消息并记录诊断，禁止丢弃尚未进入摘要的尾部消息。
9. 返回新数组后记录本次实际使用的 checkpoint ID、session、epoch 和事件时的 branch leaf。后续请求重复执行全部校验，不能仅依赖内存标记。
10. handler 内部错误不得向 agent-core 抛出；记录诊断并返回 `event.messages`。该后备处理保持消息语义，但在没有可用 checkpoint 时不能保证 provider 请求低于上下文窗口。

虚拟压缩后的 provider usage 只描述虚拟摘要和当前尾部。`ctx.getContextUsage()` 以及 Pi 的 threshold 检查可能因此保持在正式阈值以下，这正是 `agent_settled` 后主动正式化的必要原因。

## 正式 compaction 的复用规则

`session_before_compact` 收到 Pi 当前的 `preparation`、`reason`、`willRetry`、`customInstructions` 和事件 `signal` 后，按以下顺序处理：

1. 收到与现有 checkpoint claim 不同的事件 `signal` 时，先释放旧 attempt 的领取，并读取当前 `pendingFormalization`。
2. 支持以下三类事件：模式不是 `"off"` 时的 `reason: "threshold"`；与 `pendingFormalization` 精确匹配的内部 `reason: "manual"`；`precomputeMode: "threshold-and-manual"` 下由使用者发起且无 `customInstructions` 的 `reason: "manual"`。
3. `reason: "overflow"`、`willRetry: true` 或存在 `customInstructions` 时返回空结果。模式变为 `"off"` 后，内部 manual 请求也返回空结果，由已经启动的 Pi compaction 使用原生摘要完成。
4. 通过 `ctx.sessionManager.getBranch()` 获取最新分支，并计算当前 `sessionId` 与 `epochCompactionId`。内部 manual 请求必须与 pending 记录的 session、epoch 和 checkpoint ID 相同。
5. 从当前分支由新到旧扫描 `pi-press.precompaction` entry，依次执行 schema、版本、session 和 epoch 校验；内部请求只检查指定 checkpoint。
6. 在当前分支中定位 `snapshotLeafId` 与 `compaction.firstKeptEntryId`。两者必须存在，且 `firstKeptEntryId` 的位置不得晚于 `snapshotLeafId`。entry 类型不限定为 user/assistant。
7. 确认当前分支继承 `snapshotLeafId`。在 Pi append-only session 契约下，这同时证明 snapshot 之前的摘要输入未被替换。
8. 确认 checkpoint 尚未被正式 compaction entry 的 `details.piPress.checkpointId` 引用，也未被当前 compaction attempt 领取。
9. 使用 checkpoint 摘要和 `firstKeptEntryId` 模拟压缩后上下文：
   - 通过公开 `buildSessionContext` 取得当前 active messages，并对其使用 `estimateTokens`；
   - 计算 `fixedOverhead = max(0, currentPreparation.tokensBefore - currentMessagesEstimatedTokens)`，保留系统提示词、工具定义及其他未体现在消息字符数中的估算开销；
   - 以 checkpoint summary 作为 compaction summary；
   - 从当前分支的 `firstKeptEntryId` 开始，通过 `sessionEntryToContextMessages` 收集保留消息；
   - Pi-press custom entry 和其他 context-invisible metadata 不产生消息；
   - `estimatedTokensAfter = fixedOverhead + summaryEstimatedTokens + keptMessagesEstimatedTokens`。
10. 计算容量限制：

```text
safetyMargin = max(4096, ceil(contextWindow * 0.02))
hardLimit = contextWindow - currentPreparation.settings.reserveTokens - safetyMargin
targetLimit = floor(contextWindow * targetPostCompactionPercent / 100)
acceptLimit = min(hardLimit, targetLimit)
```

`estimatedTokensAfter` 必须小于或等于 `acceptLimit`。当前模型、context window 或限制不可用时返回空结果。

11. 找到 ready checkpoint 后立即领取，并中止同 epoch 中不再需要的后台任务。
12. 没有 ready checkpoint 时，查找满足相同 session、epoch、算法版本和祖先条件的 in-flight 任务。snapshot key 无需与当前叶子相等；内部 manual 请求只等待能够生成其指定 checkpoint 的任务。
13. 在 `hookWaitTimeoutMs` 和事件 `signal` 约束内等待兼容任务。超时或取消时先将任务标记为 discarded、清除当前任务身份，再发送 abort 并返回空结果；成功后重新从步骤 4 开始读取和校验。
14. 同一时间只允许一个 compaction hook 领取 checkpoint。

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

## `agent_settled` 后正式化

`agent_settled` 表示 Pi 已经完成当前 session 级运行中的自动重试、自动 compaction 和排队消息续跑。扩展按以下步骤将已使用的虚拟压缩转为正式 session 状态：

1. handler 检查 `virtualCheckpointId` 是否存在、对应 checkpoint 是否至少成功用于一次 provider 请求、当前是否没有 `pendingFormalization`。
2. handler 只安排延迟回调并立即返回，避免在扩展 runner 正在分发 `agent_settled` 时重入 `session_before_compact`。
3. 回调执行时重新检查 `ctx.isIdle()`、session ID、epoch 和 checkpoint，并确认当前分支仍继承虚拟请求时记录的 leaf 与 checkpoint snapshot；当前 leaf 可以包含该请求随后追加的 assistant/toolResult。其他扩展已经启动新 agent 运行时保留虚拟状态，等待下一次 `agent_settled`。
4. 如果 Pi 原生检查已经写入正式 compaction，当前 epoch 会变化；回调清除旧虚拟状态且不调用 `ctx.compact()`。
5. 校验通过后创建 `pendingFormalization`，至少记录 request ID、checkpoint ID、session ID、epoch、调度时 leaf、尝试次数和开始时间。
6. 调用 `ctx.compact({ onComplete, onError })`，不传 `customInstructions`。该 API 不返回可等待的 Promise；同一 pending 状态只允许调用一次。
7. Pi 发出 `session_before_compact(reason: "manual")` 后，`beforeCompact()` 通过当前 pending 状态、session、epoch 和 checkpoint ID 识别内部请求，并按正式复用规则返回 checkpoint。事件本身没有 request ID；checkpoint 已失效时返回空结果，让 Pi 生成原生摘要。
8. Pi 调用 SessionManager 追加正式 `type: "compaction"` entry，随后通过 `buildSessionContext()` 重建 `agent.state.messages` 并发出 `session_compact`。扩展不得调用 `pi.appendEntry()` 或自行写 JSONL 模拟这一步。
9. `session_compact` 是成功状态的权威事件；它清除 virtual、pending、claim 和旧 epoch 后台任务。`onComplete` 只负责补充诊断和通知，必须允许在 `session_compact` 之后执行。
10. `onError` 清除 pending 并记录失败。只要 session、epoch 和 checkpoint 仍有效，虚拟压缩继续保护后续 provider 请求；同一 Runtime 实例、session 和 epoch 的下一次 `agent_settled` 最多再尝试一次。

正式 entry 写入成功后，后续请求使用 Pi 重建的原生上下文：

```text
正式 compaction summary
+ firstKeptEntryId 开始的 context-visible 消息
+ 正式 compaction entry 之后的新消息
```

此时 `context` 处理器观察到新的 epoch，不再使用旧虚拟 checkpoint。后续 resume 也由 Pi 从正式 compaction entry 重建相同上下文。进程在 `onComplete` 前退出或正式压缩失败时，不能声称正式 entry 已持久化；已写入的 custom checkpoint 仍可在 resume 后重新通过虚拟校验，并在下一次 `agent_settled` 再次正式化。

## 检查点失效和后备处理

以下情况使 checkpoint 不可消费：

- 当前 checkpoint 的 Pi 版本、checkpoint schema、preparation 算法版本或摘要格式版本与运行时不匹配；
- 当前 `precomputeMode` 为 `"off"`；内部正式化已交给 Pi 后只停止复用 checkpoint，不中止宿主 compaction；
- `reason` 为 `overflow`、`willRetry` 为真或存在 `customInstructions`；
- 使用者发起的 `reason: "manual"` 未启用 `"threshold-and-manual"`，或者内部 manual 事件与 `pendingFormalization` 的 checkpoint、session 或 epoch 不匹配；
- 当前 session 与 checkpoint session 不同；
- 当前分支不继承 `snapshotLeafId`；
- `firstKeptEntryId` 不在当前分支中，或位于 `snapshotLeafId` 之后；
- 当前最新正式 compaction ID 与 `epochCompactionId` 不同；
- summary 为空，usage/details 数据无效，或 entry 引用损坏；
- checkpoint 已被正式 compaction 消费或已被当前 hook 领取；
- 当前模型的 context window 不可用；
- `estimatedTokensAfter` 超过正式复用容量限制；虚拟应用超过 target limit 时可以继续使用并请求刷新，超过 hard limit 时不可应用；
- 等待 in-flight 任务超时或被事件 signal 取消。

模型、thinking level、provider endpoint 或生成预算变化本身不会使已有摘要失效；这些变化只影响新任务去重和当前容量计算。

checkpoint 不可用于正式 compaction 时，扩展返回空结果，由 Pi 原生 compaction 生成摘要并继续写入正式 entry。checkpoint 不可用于虚拟请求时，`context` 返回事件原消息；该处理保持完整消息语义，但不能单独保证请求不会超过 provider 上下文窗口。原始 session entry 始终保持完整。

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

- `session_start`：通过 `ctx.sessionManager.getEntries()` 和 `getBranch()` 恢复当前分支 checkpoint、正式 compaction epoch 与消费记录；内存中不恢复“已经应用”标记，首次 `context` 必须重新校验后再记录。
- `context`：从当前事件消息和分支构造虚拟上下文；正式 compaction epoch 变化时清除旧虚拟状态。
- `turn_end`：检查软阈值、调度或刷新 checkpoint；不调用 `ctx.compact()`。
- `agent_end`：不发起正式压缩，等待 Pi 完成自动重试、自动 compaction 和排队消息处理。
- `agent_settled`：在虚拟 checkpoint 已实际使用且 `ctx.isIdle()` 为真时，安排一次延迟的正式化检查。
- `session_before_tree`：递增内存 `runEpoch`，中止当前任务，取消尚未发起的正式化调度并清除虚拟状态，确保旧分支闭包不能追加 entry 或发起 compaction。
- `session_tree`：按新分支恢复状态；不重复递增已经由 `session_before_tree` 更新的 `runEpoch`。
- `session_shutdown`：递增 `runEpoch`，中止任务，取消正式化调度并清除 session-bound 引用；处理器不等待后台 provider Promise，后台闭包不得再访问失效的 `pi` 或 `ctx`。已经交给 Pi 的 compaction 结果以宿主最终事件为准。
- `session_compact`：记录消费，清除 virtual、pending 和调度状态，递增 `runEpoch`，中止旧 epoch 任务并以新正式 compaction ID 开始下一轮。
- `model_select` 和 `thinking_level_select`：不注册专用处理器；后续任务和 `context` 从新的事件上下文读取当前模型，不改变内容 snapshot key，也不废弃已持久化 ready checkpoint。

## 运行时状态与并发

Runtime 实例维护以下状态：

```text
current session context
currentConfig
runEpoch
inFlightTask
virtualApplication(checkpointId, sessionId, epochCompactionId, lastAppliedLeafId)
formalizationSchedule(requestId, runEpoch)
pendingFormalization(requestId, checkpointId, sessionId, epochCompactionId, scheduledLeafId, attempt)
compactionHookInFlight
checkpointClaim(checkpointId, signal)
attemptsBySnapshotKey
formalizationAttemptsByEpoch
refreshesByEpoch
diagnostics
```

宿主进程通过版本化 `globalThis` Symbol 为所有重新导入的 Runtime 模块实例维护：

```text
activeBackgroundOperation
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
- 宿主进程内同一时间只允许一个后台操作；取消后尚未结束的认证或 provider Promise 继续占用名额，reload 后重新导入的 Runtime 实例也必须遵守。
- 同一 Runtime 实例同一时间只允许一个 compaction hook。
- 同一 session 和 epoch 只允许一个正式化调度或 `pendingFormalization`；request ID 用于忽略过期 callback。
- `virtualApplication` 只表示某 checkpoint 曾成功用于请求，不能替代每次 `context` 的 branch 和容量校验。
- `agent_settled` handler 不同步调用 `ctx.compact()`；延迟回调在调用前比较 `runEpoch`、session、epoch、checkpoint、pending 状态和 `ctx.isIdle()`，并确认当前分支继承调度时 leaf，禁止要求当前 leaf 完全相等。
- Pi 原生 `session_compact` 可能先于正式化回调发生；epoch 变化后回调必须静默退出。
- `ctx.compact()` 发起后通过 `pendingFormalization` 阻止重复调用。`session_compact` 清理成功状态；`onError` 只在 request ID 仍匹配时清理失败状态。
- 每个异步阶段完成后先比较捕获的 `runEpoch` 和当前任务身份；任一不一致时停止，且不得读取失效的 session-bound 对象、追加 entry 或发起 compaction。
- `session_before_tree`、`session_shutdown` 和 `session_compact` 递增 `runEpoch` 并中止当前任务；`session_tree` 只恢复新分支状态。
- 任何超时、取消或主动废弃操作都必须先清除任务身份，再发送 abort。即使 provider 忽略取消，旧 Promise 也不能通过追加前检查。
- `session_before_compact` 领取 checkpoint 后保存 checkpoint ID 与事件 signal；signal 取消、正式消费或新的 compaction attempt 使用不同 signal 时释放领取。
- 成功生成 ready checkpoint 后，同一 snapshot key 不再发起请求；明确失败时按 retry/cooldown 配置决定是否重试。
- 刷新任务受固定的同 epoch 一次刷新限制，并且必须使用新的 `snapshotSourceLeafId`；恢复 session 时通过同 epoch 的兼容 ready checkpoint 数量恢复已完成的刷新次数。
- 所有状态检查和完整 v3 schema 校验发生在 `pi.appendEntry()` 前；检查通过后立即同步追加 custom entry。
- 正式 compaction epoch 只由当前分支最新正式 compaction entry ID 表示，不维护额外整数 generation。

## 费用和诊断

预压缩请求会产生独立 provider usage。ready checkpoint 的 usage 持久化在 checkpoint 中；被正式 compaction 消费后，同一 usage 写入正式 compaction entry，由 Pi session stats 统计一次。

未消费或追加前失效的请求不会进入 Pi 原生 session stats。Pi-press 必须单独统计：

- 启动、成功、失败、取消、ready、消费和废弃次数；
- 虚拟压缩的应用、跳过、边界映射失败、容量不足和所用 checkpoint ID；
- 正式化的调度、发起、成功、失败、重复抑制和原生压缩优先次数；
- ready 命中率、原生回退次数和 hook 等待时间；
- consumed usage 与 discarded usage；
- 生成时、虚拟应用时和正式消费时的预计 token；
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
- provenance 使用解析后的实际 endpoint，并移除 URL username、password、query 和 fragment；
- 有效 provider 的 `streamSimple` 适配器支持内置 provider、配置覆盖 endpoint 和扩展 provider；
- 后台请求的 retry、总超时、AbortSignal 和 provider 错误均能释放实例内 in-flight 状态；底层认证或 provider Promise 未结束时继续占用进程级活动名额；
- 摘要完成后模型或 thinking level 变化时，ready checkpoint 保留，消费容量按当前模型重新计算。

### Checkpoint 与 Pi 扩展

- `turn_end` 处理器在延迟摘要 Promise 未完成时已经返回，证明后台请求未阻塞 agent 事件；
- `ctx.getContextUsage()` 无可用值时不启动任务；从低于阈值到跨越阈值时只启动一次；
- checkpoint v3 schema、未知版本、非有限数字、空 summary、无效 usage/details 和损坏 entry 引用均有验证；
- 生成结果在 `pi.appendEntry()` 前通过完整 v3 parser，非法 provenance 不得持久化；
- `pi.appendEntry()` 写入的 checkpoint 和 metrics custom entry 不进入 LLM 上下文；
- ready checkpoint 返回兼容 `CompactionResult`，并使用当前 preparation 的 `tokensBefore`；
- 正式 compaction details 同时保留 `readFiles`、`modifiedFiles` 和 `piPress`；
- Pi 写入正式 compaction 后能够正确重建上下文，后续 Pi-press compaction 与原生回退均保留文件上下文；
- session 重启后通过 `getEntries()`/`getBranch()` 恢复 ready checkpoint、epoch 和消费状态，不读取 JSONL 文件；
- 同一 signal 内 checkpoint claim 保持独占，新的 compaction signal 可以恢复领取未消费候选；
- snapshot key 只用于去重；当前叶子变化后，祖先兼容的 ready 或 in-flight checkpoint 仍可消费；
- 模拟正式压缩后的 token 包含从当前 preparation 推导的 fixed overhead；超过 hard limit 或 target limit 时返回空结果。

### 虚拟上下文与正式化

- 每次 provider 请求前都会执行 `context` handler；checkpoint 未 ready、失效或发生异常时返回事件原消息。
- ready checkpoint 生成一个 `compactionSummary`，并准确保留 `firstKeptEntryId` 开始的 context-visible 消息。
- 首次虚拟请求、连续多次工具调用和后续请求均使用同一摘要并追加最新尾部；assistant/toolResult 顺序和 tool call ID 配对保持有效。
- 并行工具批次的所有结果都在下一次 provider 请求中出现，不在单个 `tool_execution_end` 时提前构造上下文。
- `event.messages`、agent 内部 transcript、SessionManager entry 和 checkpoint 数据均未被虚拟转换修改。
- 虚拟 provider usage 小于完整 transcript usage 时，Pi 原生 threshold 可能不执行；该情况仍会进入 `agent_settled` 正式化。
- 虚拟容量不超过 target limit 时应用；超过 target 但未超过 hard limit 时继续应用并请求刷新；超过 hard limit 且等待刷新失败时保留原消息并记录诊断。
- Pi-press 前后存在其他 `context` handler 时保持扩展注册顺序；前置 handler 转换消息内容后仍保留转换结果，注入消息及保留消息的 token 增量计入虚拟容量，边界无法无歧义映射时不丢弃其他扩展消息。
- `turn_end` 和 `agent_end` 不调用 `ctx.compact()`；`agent_settled` handler 返回后才运行正式化回调。
- `ctx.isIdle()` 为假、session/branch/epoch 已变化、没有实际应用的虚拟 checkpoint 或存在 pending 请求时不发起 compaction。
- Pi 原生 compaction 先完成时，`session_compact` 清除虚拟状态，延迟回调不再发起 manual compaction。
- 默认 `precomputeMode: "threshold"` 下，内部 manual 请求凭 `pendingFormalization` 复用指定 checkpoint；使用者 `/compact` 仍需 `"threshold-and-manual"`。
- `session_before_compact` 拒绝内部候选时，Pi 原生摘要仍能完成正式 compaction；`reason: "overflow"` 和 `willRetry: true` 保持原生处理。
- `session_compact`、`onComplete` 和 `onError` 的不同回调顺序均不会重复发起或错误清除其他 request 的状态。
- 正式 entry 写入后，当前 agent state 与重新 resume 的 session 都只包含正式摘要和保留尾部；旧虚拟 checkpoint 因 epoch 不匹配而停止应用。

### 并发和生命周期

至少覆盖：

- 后台摘要完成后再触发 threshold compaction；
- threshold compaction 开始时后台任务仍在生成，并在等待时间内完成；
- hook 等待超时后中止后台任务；旧任务不能追加 checkpoint，底层 Promise 结束前继续占用进程级活动名额；
- ready checkpoint 被领取时中止同 epoch 的其他后台任务；
- 正式 compaction 先发生，旧 epoch 任务随后完成但不能追加 checkpoint；
- `session_before_tree` 中止任务，`session_tree` 恢复新分支，返回旧分支后恢复持久化 checkpoint；
- `session_shutdown` 和 reload 后旧后台闭包不访问失效的 `pi`/`ctx`，shutdown handler 不等待延迟 provider Promise；
- 模型或 thinking level 变化后的后续任务使用新的 provenance，但不改变内容 snapshot key，也不废弃 ready checkpoint；
- 同一 Runtime 内重复 `turn_end`、多个 Runtime 实例和重新导入的模块实例同时调度时均只启动一个后台操作；
- 同一 snapshot key 去重、明确失败后的受控重试和每 epoch 最多一次刷新；
- 认证或 provider 请求超时后，底层 Promise 完成前新的 Runtime 实例不得发起重叠请求；
- `precomputeMode` 三种取值及运行中切换到 `"off"`；
- manual `/compact`、内部 `ctx.compact()`、`customInstructions`、所有 overflow compaction 和 `willRetry` 均按支持范围复用或回退；
- 多个连续 `agent_settled`、延迟正式化回调、使用者新 prompt 和 Pi 原生 compaction 竞争时，同一 session/epoch 最多存在一个 pending 正式化请求；
- 分支切换、session shutdown 和 reload 使过期正式化回调失效，旧回调不得调用 `ctx.compact()`；
- 正式化失败后保留有效虚拟状态，同一 Runtime 实例、session 和 epoch 最多重试一次；
- consumed usage 进入正式 compaction 一次，discarded usage 只进入 Pi-press 诊断统计。

## 验收标准

1. 当前安装的 Pi 版本尝试执行预压缩；公开 API 不兼容、provider、超时或结果校验失败时通过 CLI 显示错误，并保留 Pi 原生 compaction 后备处理。
2. 上下文使用量跨越默认 80% 软阈值后调度 detached task，`turn_end` 不等待摘要请求，当前 agent 不被中止。
3. `ctx.getContextUsage()` 返回不可用值时不启动任务，也不读取 session 文件自行估算。
4. 生产代码只使用 Pi 扩展契约和包根入口；唯一自有协议适配集中在 preparation 版本适配模块。
5. 版本适配模块与当前 Pi 公开事件提供的 preparation 在目标 fixture 上一致，包括 split turn、metadata 边界、前次摘要和文件操作。
6. 后台摘要调用公开 `compact()`，保留原生提示词、`previousSummary`、split turn、usage 和文件上下文语义。
7. 模型请求使用有效 provider，并保留解析后的 `baseUrl`、`apiKey`、headers 和 `env`；checkpoint provenance 使用实际 endpoint 的脱敏副本，认证失败时安全回退。
8. checkpoint 以 `pi-press.precompaction` v3 custom entry 持久化；追加前通过完整 v3 parser，entry 默认不进入 LLM 上下文，也不复制原始消息。
9. ready checkpoint 在下一次 `context` 事件中生成请求级 `compactionSummary` 和当前保留尾部，不发起第二次摘要请求。
10. 后续每次 provider 请求重新校验并构造虚拟上下文，checkpoint 后新增的 assistant 和工具结果完整保留，Pi 内部 transcript 和 JSONL 原始消息保持不变。
11. 并行工具批次完成后的下一次请求包含整批 tool result，工具调用和结果顺序满足 Pi 原生约束。
12. 其他扩展修改 `context` 时保持 handler 顺序；无法无歧义映射保留边界或 handler 内部失败时返回事件原消息，不丢弃其他扩展内容。
13. 虚拟容量低于 target limit 时正常应用；介于 target 与 hard limit 时继续应用并调度刷新；超过 hard limit 且无及时完成的新 checkpoint 时记录保护能力不足。
14. 虚拟请求的 provider usage 即使使 Pi 原生 threshold 保持未满足，已实际应用的 checkpoint 仍会在 `agent_settled` 后进入正式化。
15. `turn_end` 和 `agent_end` 不调用 `ctx.compact()`；`agent_settled` 只安排延迟回调，回调在 `ctx.isIdle()`、session、epoch 和分支祖先校验通过后发起一次调用；虚拟请求后正常追加的 assistant/toolResult 不使回调失效。
16. Pi 原生 compaction 在正式化回调前完成时，以 `session_compact` 为准，扩展不再发起 manual compaction。
17. 默认 `precomputeMode: "threshold"` 下，内部 `reason: "manual"` 事件通过 `pendingFormalization` 精确匹配并复用指定 checkpoint；使用者 `/compact` 只有在 `"threshold-and-manual"` 且无自定义指令时复用。
18. 内部 checkpoint 在正式化时失效或容量不足时，Pi 原生摘要继续完成正式 compaction；`reason: "overflow"`、`willRetry: true` 和自定义指令保持原生处理。
19. 正式 `compaction` entry 只由 Pi 写入，包含摘要、边界、当前 `tokensBefore`、usage、原生文件 details 和 `details.piPress`；Pi 随后重建 `agent.state.messages`。
20. `session_compact` 清除 virtual、pending、claim 和旧 epoch 任务；其后 `context` 使用 Pi 正式摘要和保留尾部，不再注入旧虚拟摘要。
21. session 重启后，正式压缩成功的分支由 Pi 从正式 entry 重建；正式化尚未成功时，持久化 checkpoint 可以重新通过虚拟校验，并在后续 `agent_settled` 再次正式化。
22. 当前叶子晚于 snapshot 时，祖先兼容的 checkpoint 仍可使用；分支切换和返回旧分支后按 session、祖先、epoch 和容量重新判断，snapshot key 不作为消费相等条件。
23. compatible in-flight checkpoint 在等待时间内完成时可以消费；超时后任务被中止，旧任务不得追加 checkpoint，Pi 原生摘要仍可执行。
24. 正式消费前模拟的 `estimatedTokensAfter` 同时满足 hard limit、目标比例和安全余量；`firstKeptEntryId` 可以是 Pi 允许的 metadata 边界。
25. 正式 compaction ID 是唯一持久化 epoch；旧 epoch 的后台结果、虚拟状态和延迟正式化回调都无法追加、应用或消费。
26. 同一 snapshot 不并发生成重复摘要；多个 Runtime 实例及 reload 后重新导入的模块实例共享进程级后台活动占用；同一 session/epoch 最多存在一个 pending 正式化请求。
27. `session_compact`、`onComplete`、`onError`、session shutdown 和分支事件以任意有效顺序到达时，状态清理保持幂等；正式化失败后，同一 Runtime 实例、session 和 epoch 最多重试一次。
28. Pi-press 区分 virtual、consumed 和 discarded 统计；正式 compaction usage 不重复计费，未消费费用单独记录，成功、回退和保护能力不足均提供对应诊断。
29. `npm run typecheck` 和 `npm test` 通过，并包含上述版本适配、provider、checkpoint、虚拟上下文、正式化、并发、生命周期和原生后备处理测试。
