# pi-press 代码规范

## 适用范围

本文件规定 `pi-press` 后续 TypeScript 扩展实现的代码结构、Pi API 使用方式、异步生命周期、持久化数据和验证要求。

规范依据：

- Pi 扩展规范：[extensions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- Pi 压缩规范：[compaction.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md)
- 项目设计：[docs/DESIGN.md](DESIGN.md)

规范中的“必须”表示禁止偏离；“应”表示默认要求，偏离时需要在代码或设计文档中说明；“可”表示按实现需要选择。

当前项目依赖 `@earendil-works/pi-coding-agent >=0.84.1`，Node.js 版本以实际安装的发行包要求为准。设计文档是 `pi-press` 的行为契约，本文件负责把该契约转换为代码组织和实现规则。

npm 发布包中的 Pi 核心包必须声明为 `peerDependencies: "*"`，由 Pi 宿主提供；本地类型检查和测试使用 `devDependencies` 中的最低兼容版本，禁止把 Pi 核心包作为普通运行时依赖随扩展重复安装。

## 核心原则

1. **扩展契约优先**：通过 Pi 官方扩展 API 接入运行时，只依赖包根入口导出的公开类型、函数和事件。
2. **原生语义优先**：摘要编排、正式 compaction entry、session tree、上下文恢复和 TUI 行为由 Pi 负责；`pi-press` 只实现预压缩调度、版本适配和 checkpoint 管理。
3. **追加式状态**：扩展状态通过 `pi.appendEntry()` 追加 custom entry，原始 session entry 不被覆盖、删除或重写。
4. **失效即回退**：schema、分支、容量、认证、并发或公开 API 条件无法满足时返回空结果，由 Pi 使用原生实现；运行时错误和正式 compaction 状态通过 CLI 通知报告。
5. **边界可验证**：所有跨 API、session、provider、异步任务和持久化数据边界都必须有明确类型、校验和测试。
6. **副作用集中管理**：纯计算放在无副作用模块中；文件、provider、session 和 UI 操作只出现在相应的适配层或生命周期处理器中。

## 扩展形态

### 默认入口

Pi 扩展必须导出一个默认工厂函数。工厂接收 `ExtensionAPI`，负责注册事件和能力：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function registerPiPress(pi: ExtensionAPI): void {
  const runtime = createRuntime(pi);

  pi.on("session_start", (_event, ctx) => {
    runtime.restore(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    runtime.onTurnEnd(ctx);
  });

  pi.on("session_before_compact", (event, ctx) => {
    return runtime.beforeCompact(event, ctx);
  });

  pi.on("session_compact", (event, ctx) => {
    runtime.onCompact(event, ctx);
  });

  pi.on("session_shutdown", () => {
    runtime.shutdown();
  });
}
```

上例只表示入口职责。`createRuntime`、状态机和压缩算法必须位于独立模块，`index.ts` 不得承载 checkpoint schema、provider 请求和切分算法。

工厂函数可以是异步函数，但 `pi-press` 工厂默认保持同步。工厂阶段不得启动 session 级定时器、文件监听器、子进程或 provider 后台请求。需要 session 生命周期的资源只能在 `session_start` 或实际使用资源的事件、命令、工具中创建，并在 `session_shutdown` 中释放。

### 推荐文件组织

Pi 官方支持单文件扩展和目录扩展。`pi-press` 包含版本适配、并发和持久化逻辑，采用目录扩展形式：

```text
src/
├── index.ts                         # Pi 扩展默认入口，只负责组装
├── extension-runtime.ts             # session 级运行时和事件协调
├── config.ts                        # 配置读取、默认值和范围校验
├── types.ts                         # 公共内部类型和版本常量
├── diagnostics.ts                   # 诊断与指标，不记录敏感信息
├── checkpoint/
│   ├── schema.ts                    # checkpoint v3 运行时校验
│   ├── store.ts                     # custom entry 读取、追加和恢复
│   └── selection.ts                 # 祖先、epoch、消费状态和容量筛选
├── compaction/
│   ├── preparation.ts               # 当前 Pi preparation 版本适配
│   ├── compact.ts                   # 公开 compact() 调用和 provider 适配
│   └── reuse.ts                     # session_before_compact 复用逻辑
└── provider/
    └── request.ts                   # API key、headers、endpoint 和 env 解析

tests/
├── unit/                            # 纯函数、schema、配置和状态转换
├── integration/                     # 公开 Pi SDK、模拟 provider 和 session fixture
└── fixtures/                        # 固定 session 分支和 provider 数据
```

目录名称和文件名使用小写 kebab-case；入口文件使用 `index.ts`。实际实现可以合并规模很小的模块，但不得把所有状态、I/O 和算法重新放回入口文件。

若作为项目本地扩展加载，推荐使用 `.pi/extensions/pi-press/index.ts`。若作为 npm 或 git 包分发，使用包 `package.json` 的 `pi.extensions` 声明入口，例如：

```json
{
  "name": "@sunnyx11/pi-press",
  "type": "module",
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

开发期间可使用 `pi -e ./src/index.ts` 加载单个入口。自动发现位置、包依赖和项目可信判断遵循 Pi 官方规范；扩展运行具有宿主进程的完整权限，只能加载可信来源。

## 模块边界

### `index.ts`

入口只允许完成以下工作：

- 创建一次当前扩展实例的运行时对象；
- 注册 Pi 事件处理器；
- 注册项目明确需要的命令、工具或其他扩展能力；
- 将事件转发给运行时对象。

入口不得：

- 读取 session JSONL 文件；
- 解析 provider 请求；
- 构造 `CompactionPreparation`；
- 管理多个全局 singleton；
- 在模块加载时启动异步后台任务；
- 捕获并长期持有已经结束 session 的 `ctx` 或 `SessionManager`。

### 纯模块

配置规范化、snapshot key、schema 校验、祖先判断、容量计算、状态转换和 checkpoint 版本兼容性判断应使用纯函数。纯函数的输入和输出必须显式，禁止通过模块级可变变量传递 session 数据。宿主进程级活动操作通过版本化 `Symbol` 保存，只作为重新导入的 Runtime 实例间的并发信号量，不得提供 session 内容访问接口。

### 适配模块

与 Pi 或 provider 的交互集中在适配模块：

- `compaction/preparation.ts` 只负责从公开 session 数据构造 `Parameters<typeof compact>[0]` 所需 preparation；
- `compaction/compact.ts` 只负责调用公开 `compact()` 并保留 Pi 的摘要、usage、split turn 和文件操作语义；
- `provider/request.ts` 只负责活动模型、认证结果、endpoint、headers、env 和 provider stream 的适配；
- `checkpoint/store.ts` 只负责通过 `SessionManager` 读取和通过 `pi.appendEntry()` 追加扩展 entry。

版本适配不能散落在业务逻辑中。Pi 版本升级时只允许在适配模块和 checkpoint 兼容性校验中处理差异，并补充对应差异测试。

## 导入与公开 API

### 导入规则

生产代码必须使用包根入口：

```ts
import {
  compact,
  estimateTokens,
  findCutPoint,
  type CompactionResult,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
```

允许的依赖来源：

- `@earendil-works/pi-coding-agent`：扩展 API、SessionManager、compaction 公开函数和公开类型；
- `@earendil-works/pi-ai`：公开 provider、模型和 usage 类型；
- `typebox`：Pi 工具参数 schema，以及项目需要的运行时 schema；
- `@earendil-works/pi-tui`：仅在确有自定义 TUI 时使用；
- `node:` 前缀的 Node.js 内置模块；
- `package.json` 明确声明的第三方依赖。

以下写法禁止出现在生产代码和测试代码中：

- `@earendil-works/pi-coding-agent/dist/...`；
- `@earendil-works/pi-coding-agent` 未导出的深层模块；
- `prepareCompaction()` 等未列入包根导出表的内部函数；
- 通过相对位置访问 Pi 安装目录；
- 手工复制 Pi 内部实现以绕过公开 API。

所有类型导入使用 `import type`。运行时导入和类型导入分开书写，避免因为类型被误当作运行时依赖而改变加载行为。

### TypeScript 基线

实现仓库应启用严格类型检查，并使用 ESM：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "noEmit": true
  }
}
```

实现仓库应启用严格类型检查，并使用 ESM。类型依赖应与实际安装的 Pi 包版本兼容，当前最低版本为 `0.84.1`。

### 命名

- 类型、接口、类和枚举使用 `PascalCase`；
- 函数、变量和方法使用 `camelCase`；
- 常量使用 `UPPER_SNAKE_CASE`，尤其是 Pi 版本、schema 版本和算法版本；
- 布尔值使用 `is`、`has`、`can`、`should` 等前缀；
- Pi 事件名、`customType`、provider API 名和协议字段保留官方拼写；
- session entry ID、checkpoint ID 和 provider model ID 按不透明字符串处理，不从字符串格式推导业务含义；
- 自定义 custom entry 类型统一使用 `pi-press.` 前缀，例如 `pi-press.precompaction` 和 `pi-press.metrics`。

代码注释统一使用规范简体中文。注释只说明边界、原因和不会从代码结构中自然显现的约束，不重复代码动作。

## Pi 事件与生命周期

### 注册规则

事件处理器在默认工厂中注册一次。需要恢复 session 状态时，使用 `session_start` 重新读取当前分支；不得在每次 `session_start` 中重复注册同一 handler、定时器或全局监听器。

除非 Pi 事件类型明确允许修改，否则处理器只读取 event 和 ctx，通过返回值表达控制结果。`tool_call` 的输入变更、`before_provider_headers` 的 header 变更等属于 Pi 明确规定的可变接口，使用时必须保持原有 schema 和事件顺序。

### `pi-press` 事件职责

| 事件 | 处理要求 |
| --- | --- |
| `session_start` | 通过 `ctx.sessionManager.getEntries()`、`getBranch()` 恢复 checkpoint、正式 compaction epoch、消费状态和当前分支。 |
| `turn_end` | 读取 `ctx.getContextUsage()`，判断软阈值，获取快照并调度后台任务。处理器必须在后台摘要完成前返回。 |
| `session_before_compact` | 校验 reason、signal、分支、epoch、checkpoint 和容量；可返回兼容 `CompactionResult`，否则返回 `undefined` 让 Pi 使用原生实现。 |
| `session_compact` | 记录正式 entry 对 checkpoint 的消费，递增运行 epoch，取消旧 epoch 任务。 |
| `session_before_tree` | 递增运行 epoch，取消当前任务，释放当前分支绑定状态；不读取将要失效的旧 session 对象。 |
| `session_tree` | 读取新分支并恢复内存状态；不重复执行已经由 `session_before_tree` 完成的 epoch 递增。 |
| `session_shutdown` | 递增运行 epoch，先清除任务身份再发送 abort，清理 session 资源；不等待后台认证或 provider Promise，进程级占用由底层 Promise 结束时释放。 |
| `model_select` | 不注册专用处理器；后续任务从新的 `ExtensionContext` 读取模型 provenance，不废弃已有 ready checkpoint，也不改变 snapshot key。 |
| `thinking_level_select` | 不注册专用处理器；后续任务从新的 `ExtensionContext` 读取 thinking level，不承担 checkpoint 失效和消费判断。 |

首个版本不在 `agent_end` 或 `agent_settled` 中调用 `ctx.compact()`。`session_before_compact` 不支持的 `overflow`、`willRetry: true`、带 `customInstructions` 的请求必须回退 Pi 原生 compaction。

`session_before_compact` 的 handler 只在 checkpoint 完整满足项目设计时返回：

```ts
return {
  compaction: {
    summary: checkpoint.compaction.summary,
    firstKeptEntryId: checkpoint.compaction.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    usage: checkpoint.compaction.usage,
    details: {
      ...checkpoint.compaction.details,
      readFiles: checkpoint.compaction.details?.readFiles ?? [],
      modifiedFiles: checkpoint.compaction.details?.modifiedFiles ?? [],
      piPress: checkpointProvenance,
    },
  },
};
```

`tokensBefore` 必须来自本次事件的 `preparation`。checkpoint 中保存的快照值只用于诊断和生成阶段校验。

### Session 对象有效期

`pi`、`ctx`、`ctx.sessionManager`、provider 和其他 session-bound 对象只在所属扩展实例有效。`session_shutdown`、reload、new、resume、fork 或 tree 切换后，旧对象不得再次访问。

后台闭包只能捕获：

- 不可变配置；
- session ID、entry ID、snapshot key、版本号等普通值；
- 任务自己的 `AbortController` 和不可变快照。

后台闭包不得捕获并延迟使用旧的 `pi`、`ctx`、`SessionManager` 或 UI 对象。追加 checkpoint 前重新通过当前有效对象检查 session、分支、epoch 和版本。

## 异步与并发

### 后台任务

`turn_end` 只负责采样和调度。后台任务必须满足：

- 使用独立 `AbortController`，不得复用当前 agent 的 `ctx.signal`；
- 由运行时状态保存 Promise、任务身份、snapshot key、epoch 和取消控制器；
- 所有 detached Promise 都必须有统一的成功、失败、取消和 `finally` 处理；
- 发生异常时不得形成未处理的 Promise rejection；
- 调用 provider、文件或进程 API 时传递任务 signal；
- 每个 await 后，以及 `pi.appendEntry()` 前，比较任务身份和 `runEpoch`；
- 任务失效时停止，不访问失效对象，也不追加 entry。

推荐的任务收尾结构：

```ts
function startTask(input: TaskInput): void {
  const controller = new AbortController();
  const task = createTaskState(input, controller);
  runtime.inFlightTask = task;

  const promise = Promise.resolve().then(() => runTask(input, controller.signal));
  task.promise = promise;

  void promise.then(
    (result) => runtime.completeTask(task, result),
    (error: unknown) => runtime.failTask(task, error),
  );
}
```

`completeTask` 和 `failTask` 必须再次确认当前任务身份；不能仅依赖 Promise 是否完成。任务超时、取消或主动废弃时，先清除 `inFlightTask` 身份，再调用 `controller.abort()`。这样即使 provider 忽略取消，旧 Promise 也不能通过追加前检查。进程级活动操作必须覆盖 preparation、认证和 provider 请求，并且只在底层 Promise 实际结束后释放；reload 后重新导入的 Runtime 实例不得绕过该占用状态。

### 并发限制

- 同一 session、正式 compaction epoch 和 snapshot key 同时最多一个后台摘要任务；
- 宿主进程内所有 Runtime 实例同一时间最多一个后台操作；取消后尚未完成的认证或 provider Promise 仍计入该限制；
- 同一 Runtime 实例同一时间最多一个 compaction hook 领取 checkpoint；
- checkpoint 被领取后，取消同 epoch 中不再需要的后台任务；
- checkpoint claim 必须绑定事件 signal；signal 取消、正式消费或新 attempt 使用不同 signal 时释放；
- ready checkpoint 生成成功后，同一 snapshot key 不得重复请求；
- 刷新任务必须使用新的 `snapshotSourceLeafId`，且同一 epoch 最多刷新一次；
- 不以 Promise 的完成顺序代替 epoch、祖先和身份校验。

后台摘要与正式 compaction 之间存在竞争时，正式 compaction 优先。等待 in-flight 任务必须同时受 `hookWaitTimeoutMs` 和事件 `signal` 限制；等待失败后清除任务身份、发送 abort 并返回 `undefined`。

## Pi API 使用规范

### SessionManager

只通过公开 `SessionManager` 读取 session：

```ts
const entries = ctx.sessionManager.getEntries();
const branch = ctx.sessionManager.getBranch();
const leafId = ctx.sessionManager.getLeafId();
const sessionId = ctx.sessionManager.getSessionId();
```

禁止手工打开、解析、锁定或修改当前 session JSONL。禁止使用标记为测试用途的 `parseSessionEntries()`。Pi-press 的 branch、entry parent、正式 compaction 和 context 重建判断必须基于公开 session 数据。

### `pi.appendEntry()`

扩展持久化只能使用：

```ts
pi.appendEntry("pi-press.precompaction", checkpointData);
pi.appendEntry("pi-press.metrics", metricsData);
```

custom entry 不进入 LLM 上下文，可以作为 session tree 的 metadata。entry 必须是可序列化数据，追加后不得原地更新。checkpoint 在 `pi.appendEntry()` 前必须通过统一的完整 v3 parser，禁止只校验本次 provider 返回的局部字段。扩展不得手工追加正式 `type: "compaction"` entry；正式 entry 由 Pi 根据 `session_before_compact` 的返回值写入。

消费状态从正式 compaction entry 的 `details.piPress.checkpointId` 推导，不新增 consumed entry。metrics entry 只用于扩展诊断，不能改变 checkpoint 的有效性和 session 上下文。

### `ctx` 与运行模式

- 需要用户交互时先检查 `ctx.hasUI`；
- 只在 `ctx.mode === "tui"` 时使用自定义 TUI 组件、终端输入和直接渲染；
- provider、fetch、文件和进程操作使用可用的 `ctx.signal` 或任务 signal；
- 项目配置文件位置使用 `CONFIG_DIR_NAME`，不硬编码 `.pi`；
- 扩展配置独立于 Pi auto-compaction settings，不通过读取 settings 文件猜测 Pi 的运行时 compaction 开关；
- `ctx.compact()` 仅用于明确需要用户触发 Pi compaction 的扩展能力，`pi-press` 的后台任务禁止调用它。

## Preparation 与 provider 适配

### Preparation

`compaction/preparation.ts` 是唯一的 Pi 版本适配边界。其职责是：

1. 从公开 `SessionManager` 分支确定最近正式 compaction 和摘要边界；
2. 当前 Pi 公开函数选择 cut point；
3. 使用公开转换函数构造 `messagesToSummarize` 和 `turnPrefixMessages`；
4. 保留 Pi 对 context-visible message、split turn、相邻 metadata 和 tool result 的边界规则；
5. 累计前次兼容 details 中的 `readFiles` 和 `modifiedFiles`；
6. 使用公开 usage 和 token 函数生成 `tokensBefore`；
7. 产出 `Parameters<typeof compact>[0]` 所表示的 preparation。

`firstKeptEntryId` 是 Pi preparation 产生的不透明 entry ID。实现不得自行把它限制为 user 或 assistant entry，也不得在 tool result 上自行创建无 Pi 依据的切分规则。

后台摘要必须调用公开 `compact()`，复用 Pi 的摘要提示词、`previousSummary`、split turn 双摘要、usage 合并和文件标签附加。首个版本不实现自定义摘要提示词，也不单独调用内部摘要函数。

### Provider

provider 请求适配必须：

- 使用当前活动模型和当前 thinking level；
- 检查 `getApiKeyAndHeaders()` 的 `ok` 结果；认证失败时返回可诊断的原生回退；
- 保留解析得到的 `baseUrl`、`apiKey`、headers 和 `env`；
- 将值为 `null` 的 header 解释为删除，传给 `compact()` 前移除；
- 当解析结果提供 `baseUrl` 时构造带该地址的 request model；checkpoint provenance 使用实际 request endpoint 的脱敏副本，并移除 URL username、password、query 和 fragment；
- 通过 `ctx.modelRegistry.getProvider(model.provider)` 获取有效 provider，并将其 `streamSimple` 适配为 `StreamFn`；
- 传入独立任务 signal、retry 配置、超时和 callbacks；
- 认证等待收到 abort 后必须消费底层认证 Promise，并在该 Promise 结束前保留进程级活动占用；
- 不在日志、错误消息、metrics 或 checkpoint provenance 中写入 API key。

模型、thinking level、endpoint 和预算属于生成 provenance；它们不单独使已有 ready checkpoint 失效。消费时必须按当前 preparation、当前模型 context window 和当前限制重新计算容量。

## Checkpoint 数据规范

### Schema

checkpoint 使用独立协议版本。首个实现只接受 `version: 3`，并同时校验：

- `piVersion` 为生成 checkpoint 的 Pi 版本，消费时必须与当前运行时 `VERSION` 相同；
- `algorithmVersion` 和 `summaryFormatVersion` 为受支持版本；
- 字符串非空；
- 数字有限、非负且符合字段范围；
- `sessionId`、`snapshotLeafId`、`firstKeptEntryId` 和 epoch 引用存在于当前有效分支；
- `firstKeptEntryId` 位于 `snapshotLeafId` 之前或与其相同；
- `usage`、`details` 和 provenance 可序列化；
- summary 非空；
- `readFiles` 和 `modifiedFiles` 保持数组类型。

外部数据先按 `unknown` 处理，再通过运行时 schema 校验。JSON 值校验最多访问 100000 个值，嵌套深度最多为 100，超过限制的数据视为无效。未知 schema 版本、损坏 entry、非法引用和不完整数据必须忽略，并回退 Pi 原生 compaction。未知附加字段可原样保留，但不得改变已定义字段语义。

schema 版本、preparation 算法版本和摘要格式版本发生不兼容变化时，必须递增对应版本并使旧 checkpoint 不可消费。不能通过宽松解析掩盖协议变化。

### Snapshot 与 epoch

snapshot key 只用于后台去重，不作为消费相等条件。key 至少包含：

```text
sessionId
正式 compaction epoch
snapshotSourceLeafId
Pi 版本
preparation 算法版本
摘要格式版本
preparation 配置 fingerprint
```

生成模型、thinking level 和生成 provenance 不参与 snapshot key。正式 compaction epoch 只由当前分支最近正式 compaction entry 的 ID 表示；没有正式 compaction 时使用 `null`，不得维护第二个整数 generation。

追加 checkpoint 前必须重新满足：

```text
当前 sessionId == checkpoint.sessionId
当前分支包含 snapshotLeafId
当前分支包含 firstKeptEntryId
firstKeptEntryId 位于 snapshotLeafId 之前或与其相同
当前最新正式 compaction ID == checkpoint.epochCompactionId
当前 checkpoint 的 Pi 版本、算法和摘要版本仍与运行时兼容
```

### 容量校验

消费 checkpoint 前，使用当前分支和当前 preparation 模拟压缩后的上下文：

```text
fixedOverhead = max(0, currentPreparation.tokensBefore - currentMessagesEstimatedTokens)
estimatedTokensAfter = fixedOverhead + summaryEstimatedTokens + keptMessagesEstimatedTokens
safetyMargin = max(4096, ceil(contextWindow * 0.02))
hardLimit = contextWindow - reserveTokens - safetyMargin
targetLimit = floor(contextWindow * targetPostCompactionPercent / 100)
acceptLimit = min(hardLimit, targetLimit)
```

`estimatedTokensAfter` 超过 `acceptLimit`、当前模型 context window 不可用或当前限制无法确定时，checkpoint 不可消费，返回 `undefined`。

## 配置与错误处理

### 配置

配置读取与业务逻辑分离。配置按 `getAgentDir()/pi-press.json`、`cwd/CONFIG_DIR_NAME/pi-press.json` 的顺序合并，项目字段覆盖全局字段，同一文件只读取一次；无法读取、无法解析或根值不是对象的配置层只产生诊断，不覆盖已读取配置；字段必须经过类型、有限数值、百分比和时间范围校验，其中 `taskTimeoutMs` 与 `hookWaitTimeoutMs` 必须是 `1..2147483647` 范围内的整数；无效字段使用默认值并产生诊断。默认配置以 `DESIGN.md` 为准：

- `precomputeMode: "threshold"`；
- `softThresholdPercent: 80`；
- `summaryReserveTokens: 16384`；
- `taskTimeoutMs: 300000`；
- `hookWaitTimeoutMs: 1000`；
- `targetPostCompactionPercent: 50`。

候选 preparation 固定使用 `keepRecentTokens: 2000`，该值不属于 Pi-press 配置字段；后台摘要请求固定允许一次瞬时错误重试；同一正式 compaction epoch 最多刷新一次 checkpoint，这些限制均固定实现。

配置 fingerprint 必须参与 snapshot key。`precomputeMode` 切换为 `"off"` 时中止 in-flight 任务并停止消费 ready checkpoint。

### 错误分类

| 情况 | 处理方式 |
| --- | --- |
| checkpoint Pi 版本不匹配、schema 未知或 entry 引用损坏 | 记录诊断，忽略 checkpoint，返回 `undefined`；正式 compaction 继续使用 Pi 原生实现。 |
| 达到阈值但 preparation 不可用 | 记录诊断并静默跳过；后续 `turn_end` 可以再次尝试。 |
| 生成阶段容量预测超过目标比例或无法计算 | 记录容量诊断，通过 CLI warning 显示容量数值或不可用状态，丢弃本次摘要 usage，不追加 checkpoint；正式 compaction 继续使用 Pi 原生实现。 |
| 消费阶段容量预测超过目标比例或无法计算 | 记录容量诊断，通过 CLI warning 显示 checkpoint ID、容量数值和 Pi 原生回退状态。 |
| provider、公开 API、结果或 checkpoint 追加失败 | 记录不含认证信息和完整响应的失败原因，通过 CLI error 通知显示，清除任务状态并回退 Pi 原生 compaction。 |
| 后台任务总超时 | 清除任务身份，发送 abort，记录超时并通过 CLI error 通知显示；正式 compaction 回退 Pi 原生实现。 |
| hook 等待后台任务超时 | 中止对应任务，记录等待超时并通过 CLI warning 显示 Pi 原生回退状态。 |
| `ctx.getContextUsage()` 无可用值 | 跳过本次调度，不自行估算 system prompt 或 tool 定义占用。 |
| provider 认证失败、模型不可用或 context window 缺失 | 结束后台任务，记录失败原因，通过 CLI error 通知显示，回退原生 compaction。 |
| 事件 signal 取消、session shutdown 或分支切换 | 视为正常取消，释放任务状态，不产生未处理异常。 |
| provider 瞬时错误 | 固定允许一次重试；每次重试仍需传递 signal。 |
| `pi.appendEntry()` 失败 | 保留错误原因并清除任务身份，通过 CLI error 显示失败；只有 `pi.appendEntry()` 成功返回后才能显示 checkpoint ready。 |
| 内部不变量破坏 | 在测试中让错误暴露；事件边界捕获后回退，并保留带 `cause` 的诊断。 |

预期的 checkpoint 无效、provider 失败和取消不得用异常打断 Pi 的原生 compaction。需要抛出错误时使用标准 `Error`，保留 `cause`，并清除密钥、完整 provider 响应和敏感 session 内容。

所有异步入口都必须有错误处理。禁止空的 `catch`；无法恢复的错误至少转换为结构化诊断，包含阶段、错误类型、session ID 的脱敏标识和任务状态。

## 自定义工具与扩展能力

当前 `pi-press` 设计不需要自定义 LLM 工具。后续增加工具时，必须遵循 Pi 扩展规范：

- 使用 `pi.registerTool()` 注册；参数 schema 使用 `typebox`，字符串枚举使用 `@earendil-works/pi-ai` 的 `StringEnum`；
- 导出工具输入类型，事件拦截使用 `isToolCallEventType` 做类型缩小；
- `execute()` 接收并传递 `signal`，长任务通过 `onUpdate` 报告进度；
- 成功返回 `content` 和明确的 `details`；工具失败必须 `throw new Error()`，不能只返回带 error 字段的普通结果；
- 工具产生嵌套 LLM 请求时，在返回值中提供合并后的 `usage`；
- 工具输出必须限制为 50 KB 或 2000 行以内，并说明截断和完整输出位置；
- 修改文件时使用 Pi 的 `withFileMutationQueue()`，队列范围覆盖读、计算和写的完整窗口；
- 需要跨分支恢复的工具状态写入 tool result 的 `details`，不要依赖模块级变量；
- `promptSnippet` 和 `promptGuidelines` 必须准确说明工具名称和使用条件；
- 除非另有设计和集成测试，不覆盖 Pi 内置 `read`、`bash`、`edit`、`write`、`grep`、`find` 或 `ls` 工具。

命令、快捷键和 UI 只在形成明确的使用场景后添加。命令处理器可以使用 session 控制 API；事件处理器不得调用可能造成死锁的 session replacement 操作。终端 UI 必须按 `ctx.mode` 和 `ctx.hasUI` 分支，不能假设扩展总是在交互式 TUI 中运行。

## 日志与诊断

日志和 metrics 只记录诊断所需的最小信息：

- 任务启动、成功、失败、取消、ready、消费和废弃次数；
- ready 命中率、原生回退次数和 hook 等待时间；
- consumed 与 discarded usage；
- 生成阶段和消费阶段的 `estimatedTokensAfter`；
- 前台请求耗时、限流错误和后台耗时；
- 每个 epoch 的刷新次数。

禁止记录 API key、认证 header、完整摘要、完整工具结果、完整 session 内容和未经脱敏的用户输入。需要关联请求时使用 checkpoint ID、snapshot key 的脱敏摘要或计数值。

默认 metrics 保存在内存。跨重启保存聚合值时使用 `pi.appendEntry("pi-press.metrics", data)`，并确保 metrics entry 不进入 LLM 上下文。checkpoint usage 转入正式 compaction 后标记为 consumed，不能与 Pi session stats 重复相加。

## 测试规范

### 测试边界

测试必须使用实际安装的 `@earendil-works/pi-coding-agent` 发布包和包根公开接口，最低依赖版本为 `0.84.1`。测试禁止导入 `dist/core/...`、内部 `prepareCompaction()` 或手工 session JSONL 解析器。

### 单元测试

纯函数至少覆盖：

- 配置默认值、范围校验和 fingerprint；
- checkpoint v3 schema、未知版本、空 summary、非有限数值和非法引用；
- snapshot key、epoch 和祖先判断；
- 容量公式、安全余量和目标比例；
- task identity、runEpoch 和状态转换；
- provider header 的覆盖、删除和环境变量传递。

### 集成测试

使用公开 SDK、模拟 provider 和固定 session fixture 覆盖：

- 当前安装的 Pi 版本尝试启用预压缩；公开 API 不兼容时通过 CLI error 通知显示失败，并由 Pi 原生 compaction 继续处理；
- preparation 与 Pi 公开事件产生的 preparation 在 `firstKeptEntryId`、消息集合、split turn、`previousSummary`、file operations、settings 和 `tokensBefore` 上一致；
- user、assistant、bash execution、custom message、branch summary、Pi-press custom entry 和 context-invisible metadata 的边界；
- tool result 不作为错误切分点；
- 后台任务不阻塞 `turn_end`，认证失败、retry、超时、signal 和 provider 错误都能释放状态；
- ready checkpoint 被复用时不发起第二次摘要请求；
- checkpoint、metrics custom entry 不进入 LLM 上下文；
- 正式 compaction entry 由 Pi 写入，保留原生 `readFiles`、`modifiedFiles` 和 `details.piPress`；
- session 重启、tree 切换、返回旧分支和正式 compaction 后状态正确恢复；
- 同一 snapshot 去重、epoch 变化失效、每 epoch 刷新次数限制和旧 Promise 追加保护；
- manual、customInstructions、overflow、`willRetry` 和 `precomputeMode` 三种取值的复用或回退规则。

### 命令

实现仓库必须提供并在变更前后运行：

```bash
npm run typecheck
npm test
```

涉及公开 API、版本适配、provider、session 生命周期或并发控制时，必须同时运行相关集成测试。测试未覆盖的行为应在变更说明中列出，不能仅以主流程通过作为完成依据。

## 提交前检查表

- [ ] 默认入口是 `ExtensionAPI` 工厂，并且入口只负责注册和组装。
- [ ] 所有 Pi 运行时导入来自包根入口，未使用深层模块或测试接口。
- [ ] 工厂未启动 session 级后台资源；资源在 `session_start` 或实际使用时创建并在 `session_shutdown` 清理。
- [ ] `turn_end` 未等待摘要 Promise；detached Promise 具有统一错误处理。
- [ ] 每个 await 后和 `pi.appendEntry()` 前均检查任务身份、`runEpoch`、session、祖先、epoch、当前 Pi 版本和算法版本。
- [ ] checkpoint 在追加前和恢复时均通过完整 schema 校验，未手工读写 JSONL 或正式 compaction entry。
- [ ] `session_before_compact` 仅在容量和契约全部满足时返回结果，其他情况返回 `undefined` 走原生实现；新 signal 可以释放旧 attempt 的 claim。
- [ ] provider signal、headers、baseUrl、env 和认证失败处理经过测试；provenance 保存实际 endpoint 的脱敏副本，日志没有敏感信息。
- [ ] 已覆盖 split turn、metadata 边界、分支、重启、取消、超时、跨 Runtime 重复任务和旧 epoch。
- [ ] `npm run typecheck` 与 `npm test` 通过，未验证项已记录。

## 版本升级规则

升级 `@earendil-works/pi-coding-agent` 前必须：

1. 阅读新版本的扩展和 compaction 文档；
2. 对照包根导出表和类型定义检查公开 API；
3. 更新 `>=0.84.1` 依赖范围和 lockfile 中的根依赖声明；
4. 比较 Pi preparation、session entry、provider auth 和事件返回值的变化；
5. 更新版本适配模块、checkpoint 兼容性校验和差异测试；
6. 在兼容性测试通过前保留 CLI 失败通知和 Pi 原生回退。

不能因为新版本存在同名内部函数或深层文件而把它加入生产依赖。若公开 API 不足以维持契约，应优先回退 Pi 原生实现，并在设计文档中记录需要的公开接口。
