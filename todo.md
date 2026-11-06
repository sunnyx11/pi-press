# 压缩状态展示与英文文案实施计划

## 1. 状态与执行边界

- 当前状态：实施中，计划已确认。
- 按本文件执行代码、测试和现有文档修改。
- 每片验收后立即更新待办项和验证记录。
- 所有实施分片初始状态均为未开始。只有对应验收通过后才勾选完成。
- 本计划是实施任务记录。长期行为说明保存在现有 `docs/DESIGN.md` 和 `docs/CODE_STYLE.md` 中。

## 2. 已确认目标

### 2.1 原生工作指示器

- 当前请求因压缩而等待时，通过 Pi 公开的 `ctx.ui.setWorkingMessage(text)` 替换原生 `Working` 文本。
- 原生旋转动画由 Pi 管理。扩展仅更新消息文本。
- TUI 仅使用原生工作消息展示等待进度，移除 TUI 分支的 `setStatus("pi-press", text)` 及配套 footer 清理。
- 等待完成、失败、超时、取消或会话失效时，停止刷新并调用 `setWorkingMessage(undefined)` 恢复默认消息。
- 普通后台预压缩与主请求并行时，沿用当前行为，不启动这类等待提示。
- RPC 继续通过 `setStatus("pi-press", text)` 输出与清理进度。
- print、JSON 和其他无交互场景保留现有输出行为。

### 2.2 英文文案

- 采用附录 A 的已确认英文文案。
- 范围包括运行时通知、失败原因、配置告警、诊断命令、诊断记录、存储错误，以及两个独立脚本的自有输出。
- 原有通知包装前缀统一由 `pi-press：` 改为 `pi-press:`。
- 命令名、选项、字段、事件名、原因码、枚举、文件位置、模型生成内容及上游错误原文保持原值。
- 代码注释继续使用规范简体中文。
- 文档说明正文、测试标题和用于验证中文输入的测试素材保留现有语言。

### 2.3 独立性

- 实现和验证仅依赖 Pi 与 `pi-press`。
- 设计中仅识别 Pi 的公开接口与自身状态。
- 不检测、引用或依赖任何其他插件，也不为其他插件增加适配逻辑。
- 不新增 widget、自定义编辑器或宿主内部模块依赖。
- 默认 Pi 编辑器将工作指示器嵌入输入框上边框。具体位置由 Pi 管理，不承诺任意编辑器采用相同布局。

## 3. 当前事实与前置条件

本节为制定计划时的调查结果，不代表后续验证已经通过。

| 项目 | 当前事实 | 实施要求 |
| --- | --- | --- |
| 工作区 | 创建本计划前 `git status --short` 为空 | 开始实施时重新检查，并保留使用者已有修改 |
| 计划文件 | 根目录原先不存在 `todo.md` | 本文件保存本次任务清单 |
| Node / npm | Node `v22.21.1`，npm `10.9.4` | 满足仓库 Node `>=22.19.0` 要求，实施时确认环境一致 |
| 开发依赖 | `node_modules` 尚不存在 | 实施阶段按 `package-lock.json` 执行 `npm ci` |
| 固定依赖 | Pi 开发包 `1.5.0`；lockfile 已存在 | 类型检查和普通测试使用仓库固定版本 |
| 当前实现 | `startForegroundWaitProgress` 已调用 `setWorkingMessage`，同时写入 TUI footer | 在原方法内调整分支，保留现有生命周期保护 |
| 计时 | 立即刷新一次，随后每 1000 ms 刷新 | 保留现有节奏和两类等待的计时起点 |
| 冒烟脚本 | 根据中文成功、失败和进度片段判断执行状态 | 生产文案和消费条件必须在同一分片同步修改 |
| 现有测试 | UI 测试期待两处 TUI 输出，缺少完整模式与计时清理覆盖 | 更新既有断言，补充行为边界测试 |
| 真实 Pi | 仓库外部可执行文件、当前模型和认证尚待本次验证 | 真实调用只在实施阶段执行 |

## 4. 技术方案与行为约定

### 4.1 运行模式

| 场景 | 等待进度输出 | 结束处理 | 验收重点 |
| --- | --- | --- | --- |
| TUI，原生 Working 活动 | `setWorkingMessage(text)` | `setWorkingMessage(undefined)` | 文本每秒更新，spinner 继续运行，无 footer 重复消息 |
| TUI，原生 Working 未活动 | 沿用 Pi 对 `setWorkingMessage` 的处理 | 清除本次消息覆盖 | 扩展不创建指示器，不覆盖 Pi 的 compaction/retry 指示器 |
| RPC | `setStatus("pi-press", text)` | `setStatus("pi-press", undefined)` | 状态事件保留，英文内容与 TUI 一致 |
| print / JSON | 沿用当前无等待 UI 输出行为 | 无新增 UI 操作 | 无额外进度行或计时刷新 |
| `hasUI === false` | 保留当前 mode 与 hasUI 的组合分支 | 保留对应清理语义 | 覆盖 RPC 与非 RPC 组合，避免顺带改变现有契约 |
| mode 缺省或 UI 方法缺省 | 保留当前兼容与能力检查 | 正常结束 | 缺少可选方法时保持可用，不增加额外展示渠道 |

当前实现中，`mode === "rpc" && hasUI === false` 仍会执行初始状态写入与清理，但不启动 interval。该组合按现有行为回归，不借本次展示调整重新定义模式语义。

### 4.2 文本与生命周期

正常等待：

```text
pi-press: Compacting · 17s elapsed
```

前台重试：

```text
pi-press: Compacting · 17s elapsed · retry 1/3
```

底层摘要重试：

```text
pi-press: Compacting · 17s elapsed · retry 1/1
```

- 秒数继续按现有公式计算为非负整数。
- 前台循环从本次等待开始计时；兼容后台刷新等待从现有任务起点计时。
- 重试分母保持当前预算：前台 `3`，底层使用 `MAX_BACKGROUND_RETRIES`，当前为 `1`。
- 重试状态变化继续立即刷新，周期刷新仍为每秒一次。
- 保留 `finally` 清理、活动 handle 身份、closed 状态和 runEpoch 检查。
- 旧任务的迟到刷新或清理不得覆盖新等待提示。
- `setWorkingMessage(undefined)` 恢复 Pi 默认消息；它不承担保存并恢复任意来源自定义文本的职责。
- 成功、失败、warning 的触发时机与级别保持现有语义。

### 4.3 实现方式

- 在现有实现中就地修改分支与文案。
- 复用现有测试 fixture、可控 Promise、UI stub、临时 SQLite 和公开 SDK。
- 本次没有新增通用消息注册表、国际化框架、公共常量模块或生产时钟注入接口的需求证据，保持现有结构。
- 脚本中的通知识别条件使用新英文片段，与生产文案同片修改。
- 对文字替换复用现有行为测试。新增测试用于当前缺失的输出渠道、计时推进、清理和旧任务隔离，不逐条复制实现中的字符串。

## 5. 影响范围

### 5.1 必须一起修改

| 领域 | 生产文件 | 测试或消费方 | 原因 |
| --- | --- | --- | --- |
| 原生等待 UI | `src/extension-runtime.ts` | `tests/integration/concurrency.test.ts`；`scripts/smoke-real-pi.ts` 的增长进度识别 | TUI 输出渠道变化且进度改为英文 |
| 运行时通知与诊断正文 | `src/extension-runtime.ts` | `tests/unit/runtime.test.ts`；`tests/integration/background.test.ts`、`concurrency.test.ts`、`summary.test.ts`；冒烟成功/失败识别 | 原文断言与下游消费必须一致 |
| 配置告警 | `src/config.ts` | `tests/unit/config.test.ts` | 精确文案断言需同步 |
| 诊断持久化与 SQLite 错误 | `src/diagnostics.ts`、`src/diagnostics-sqlite.ts` | `tests/unit/diagnostics-persistence.test.ts`、`diagnostics-time.test.ts` | 自有诊断消息和错误正文改为英文 |
| 诊断命令 | `src/index.ts`、`src/diagnostics-command.ts` | `tests/unit/index.test.ts`、`diagnostics-command.test.ts` | 注册描述、参数错误和文本报告改为英文 |
| 时间迁移脚本 | `scripts/migrate-diagnostics-time.ts` | `tests/unit/diagnostics-time-migration.test.ts` | CLI 文案和相应错误断言需同步 |
| 冒烟脚本输出 | `scripts/smoke-real-pi.ts` | `tests/unit/smoke-script.test.ts` | 自有输出改为英文，外部 Pi 解析错误断言需同步 |
| 行为文档 | `docs/DESIGN.md`、`docs/CODE_STYLE.md` | 内容自检 | 当前设计仍描述双位置 TUI 与中文进度 |
| 任务状态 | 根目录 `todo.md` | 每片验收记录 | 保持实施状态与验证证据一致 |

### 5.2 仅需回归验证

- `tests/unit/formalization.test.ts`：正式化失败预算、取消归属、迟到事件与 epoch 保护。
- `tests/integration/formalization-cancellation.test.ts`：公开 SDK 的取消与后续恢复。
- `tests/integration/formalization-resume.test.ts`：持久化 checkpoint 恢复、尾部及 tokensBefore。
- `tests/integration/agent-loop.test.ts`：真实公开 SDK 与模拟 provider 的执行顺序。
- `tests/unit/provider.test.ts`：认证、取消和错误分类。
- `tests/unit/checkpoint.test.ts`、`preparation.test.ts`、`virtual-context.test.ts`：checkpoint、原生边界、容量估算和虚拟上下文投影。
- 配置 fingerprint、告警去重、诊断 JSON、SQLite 降级、迁移事务与备份保护。
- 真实冒烟的 basic、split、growth 分支：共享成功/失败通知消费，以及增长场景的前台进度识别。

### 5.3 明确保持原样

- checkpoint、preparation、reuse、virtual-context 和 provider 的业务算法：本次目标是展示与自有文案。
- 配置键、默认值、模式枚举、重试预算、超时、阈值及计时起点：已有语义足以满足需求。
- 事件名、原因码、JSON 结构、持久化结构与 schema 版本：作为稳定技术标识保留。
- `src/provider/request.ts` 的现有英文错误与 Pi 原生错误匹配字面量：涉及现有分类语义，保持原样。
- 包元信息和依赖版本：描述已为英文，本次不涉及发版或依赖升级。
- `README.md`：现有命令用法有效；仅当实施核查发现实际失效的相关描述或示例时修改。
- 文档导航 `AGENTS.md`：本次使用现有 docs 文件，不新增导航项。
- 测试共享 fixture：优先复用现有接口，只有必要行为缺口证明需要时再调整并记录影响。
- 中文增长素材、模型摘要、上游错误及使用者输入：它们不属于扩展固定英文输出。
- Git 提交、标签、发布、真实数据库迁移和系统配置调整：均在本计划之外。

## 6. 待办清单与依赖

依赖列包含功能依赖和共享文件造成的编辑顺序。并行是允许条件，不要求在环境资源不足时强行并发。

| 待办 | 分片 | 内容 | 前置条件 | 主要文件归属 |
| --- | --- | --- | --- | --- |
| [x] | S0 | 确认计划、核查环境、安装固定依赖并建立基线 | 使用者确认本计划 | 仅检查；安装 `node_modules`，保持清单与 lockfile 原样 |
| [x] | S1 | 原生 Working 单位置与英文进度 | S0 | runtime、concurrency、smoke 的进度识别 |
| [x] | S2 | runtime 其余英文通知、失败原因与诊断正文 | S1 | runtime、runtime/background/concurrency/summary 测试、smoke 成功/失败识别 |
| [x] | S3 | 配置告警英文 | S0 | config 及 config 单测 |
| [x] | S4 | 诊断持久化与 SQLite 英文 | S0 | diagnostics、diagnostics-sqlite 及其单测 |
| [x] | S5 | 诊断命令英文 | S0 | index、diagnostics-command 及其单测 |
| [x] | S6 | 迁移脚本英文 | S0 | migrate 脚本及其单测 |
| [x] | S7 | 冒烟脚本其余自有输出英文 | S2 | smoke 脚本及 smoke-script 单测 |
| [x] | S8 | 汇合代码分片并同步现有文档 | S1—S7 | DESIGN、CODE_STYLE、必要时 README |
| [x] | S9 | 全量类型检查、回归与变更复核 | S8 | 验证结果及必要修正 |
| [x] | S10 | 真实 Pi、默认 TUI 与最终验收 | S9 | 临时测试产物、验证记录和任务状态 |

并行规则：

- S0 通过后，S1、S3、S4、S5、S6 可以在各自文件范围内并行。
- S1 → S2 → S7 串行。它们共享 `src/extension-runtime.ts`、`tests/integration/concurrency.test.ts` 或 `scripts/smoke-real-pi.ts`。
- S2 可以与尚未完成的 S3—S6 并行；前提是编辑文件集合没有交叉。
- S3 对 runtime 的配置告警要求属于回归，`tests/unit/runtime.test.ts` 的编辑统一归 S2。
- S4 对命令和迁移的要求属于回归，命令与迁移测试的编辑分别归 S5、S6。
- 并行分片在各自边界稳定后运行定向检查。依赖其他分片的组合断言，在相关分片均完成后验证。
- 同一文件同一时间仅由一个分片修改。新增共享修改时先登记归属，再调整顺序。
- S8、S9、S10 按顺序进行。真实 provider 场景串行运行，避免并发占用和结果混淆。
- 各分片结束时统一维护本文件，状态写入串行进行。

## 7. 分片实施与验收

### S0：环境与基线

- [x] 记录确认状态、最新 `git status --short` 与已有修改，核对局部规则。
- [x] 进入代码实施前读取适用的编码与测试技能；涉及 Pi 扩展行为时读取本地官方扩展文档相关完整说明。
- [x] 按 lockfile 执行 `npm ci`，确认固定开发包实际安装成功。
- [x] 执行 `npm run typecheck` 和 `npm test`，记录退出码与基线结果。
- [x] 执行基线 `npm run test:smoke:pi`，记录仓库外部 Pi、模型和 token 数据。
- [x] 基线失败时区分环境问题与既有代码问题，记录阻塞，保持 S0 未完成。

验收标准：固定依赖可用，基线检查通过，真实 Pi 可用；新增的清单或 lockfile 差异须查明，不能把无关依赖变更带入后续分片。真实调用会使用当前配置的 provider 并可能产生费用。

### S1：原生工作消息与英文等待进度

技术范围：`startForegroundWaitProgress`、既有 UI 测试，以及 smoke growth 的进度识别。

- [x] 先更新/补充行为测试，证明当前实现会因 TUI footer 重复输出或英文进度缺失而失败。
- [x] 改为 P1—P3 文案，保留计时公式、重试优先级和即时刷新。
- [x] 移除 TUI 分支 footer 写入与清理，保留 RPC 分支。
- [x] 同步修改 smoke growth 中 `pi-press: Compacting` 的识别条件。
- [x] 验证成功、异常、超时、Esc 及 session start/tree/shutdown/compact 失效后的清理。
- [x] 验证刷新至少跨过一次 1000 ms 周期，结束后继续推进时间也无迟到更新。
- [x] 验证旧等待结束后不会清除或更新新等待的提示。
- [x] 覆盖 TUI、RPC、print、JSON、hasUI = false、mode 缺省与缺少可选 UI 方法的相关分支。
- [x] 完成定向验证并记录结果。

测试实现优先使用 `node:test` 的计时器模拟与现有可控 Promise，限于测试局部。先确认当前 Node 版本及异步任务能正确协作。若模拟影响现有任务等待，则采用局部真实计时与宽裕的任务超时，记录调整原因；保持生产时钟接口原样。

定向验证：

```bash
node --import tsx --test tests/integration/concurrency.test.ts tests/unit/smoke-script.test.ts
```

验收标准：正常 TUI 等待只调用工作消息渠道；RPC 状态仍更新并清理；无交互模式保持现有契约；计时与重试文案符合样例；所有退出与失效场景停止刷新；新增失败测试修复后通过。真实 spinner 与边框效果留在 S10 验收。

### S1 验证记录

- 状态：已完成。
- 生产实现：TUI 使用 `setWorkingMessage`，RPC 保留 `setStatus("pi-press", text)`；TUI footer 状态不再写入或清理。
- 固定文案：`pi-press: Compacting · Ns elapsed`；前台重试使用 `retry N/3`；后台任务重试使用当前预算 `retry N/1`。
- 行为测试：先运行旧实现，英文进度断言失败；实现后定向测试通过。
- `node --import tsx --test tests/integration/concurrency.test.ts tests/unit/smoke-script.test.ts`：退出码 0，41 项通过。
- 覆盖内容：TUI 单位置与清理、RPC 状态与跨秒刷新、前台重试即时文案、Esc 取消、超时、异常、会话失效以及旧任务隔离的现有回归。
- 补充验证：`tests/unit/foreground-progress.test.ts` 使用 Node 模拟时钟，23 项通过。覆盖 15 种 mode/hasUI 组合、完成后推进时间无迟到更新、旧 handle refresh/cleanup 隔离、后台与前台重试预算、四类生命周期失效、缺失或抛错的 UI 方法。该测试仅访问既有私有进度入口，生产 API 保持原样。
- 新增测试初次运行有 4 项预期数组快照错误，修正测试记录引用后 23 项通过；生产代码未因此调整。
- 冒烟脚本：growth 进度识别已同步为 `pi-press: Compacting`。
- 说明：真实 spinner 和默认 TUI 布局留在 S10；S2 负责 runtime 其余自有文案。

### S2：运行时通知、失败原因与诊断正文

技术范围：runtime 的自有字符串，不修改压缩业务决策。

- [x] 应用 N1—N16、F1—F10，以及 runtime 中 D1—D13 的对应文案。
- [x] 包括两类正式压缩成功通知、首次正式化失败提示和 checkpoint 校验/追加失败原因。
- [x] 修改统一通知包装的标点与空格。
- [x] 同步修改 basic/split/growth 的成功、失败通知识别条件；与生产文案保持同片有效。
- [x] 更新现有精确断言，保留 error/warning/info 级别与成功通知必须晚于有效 checkpoint 追加的检查。
- [x] 验证重试分类、取消静默、正式化失败预算、容量回退及错误详情处理保持现有语义。
- [x] 完成定向验证并记录结果。

- 定向验证：`node --import tsx --test tests/unit/runtime.test.ts tests/unit/formalization.test.ts tests/integration/background.test.ts tests/integration/concurrency.test.ts tests/integration/summary.test.ts tests/unit/smoke-script.test.ts`：退出码 0，102 项通过。

验收标准：运行时自有文案全部采用已确认英文；动态失败原因和容量详情同样为英文；脚本成功/失败消费条件与新文案一致；相关单元和集成测试通过。

### S3：配置告警

- [x] 应用 G1—G4，保留字段名与文件位置包装。
- [x] 同步现有配置文案断言。
- [x] 回归配置 fingerprint、移除字段识别、默认值和一次性告警行为。

- 定向验证：`node --import tsx --test tests/unit/config.test.ts tests/unit/runtime.test.ts`：退出码 0，26 项通过。

验收标准：所有自有配置告警为英文；配置结构、默认值、识别和去重行为保持现有语义。与 S2 的组合断言在 S2 完成后通过。

### S4：诊断持久化与 SQLite

- [x] 应用 D14—D18 与持久化层 F10。
- [x] 同步持久化与时间测试中的文案断言。
- [x] 验证存储失败后内存降级、告警去重、稳定事件名和 JSON 字段。
- [x] 验证原有 message 持久化隔离、时间格式和数据库 schema 保持现有语义。

- 定向验证：`node --import tsx --test tests/unit/diagnostics-persistence.test.ts tests/unit/diagnostics-time.test.ts`：退出码 0，9 项通过。

验收标准：本地诊断/存储错误为英文；稳定结构与存储行为保持现有语义；临时数据库测试通过。

### S5：诊断命令

- [x] 应用 C1—C8，同步注册描述与命令测试。
- [x] 验证全部参数错误、报告首行、数据库位置、in-memory 回退和空结果。
- [x] 使用现有 event fixture 验证文本输出；保留 JSON 输出结构与只读行为。

输入示例：

```text
/pi-press-diagnostics --session demo --last 5
```

无匹配事件且使用内存模式时的完整文本报告：

```text
pi-press diagnostics: session =demo, last 0 events
Database: in-memory
No matching diagnostic events.
```

非法参数示例：

```text
输入：/pi-press-diagnostics --last 0
输出：--last must be an integer from 1 to 100. Usage: /pi-press-diagnostics [--session <id>] [--last <1-100>] [--json]
```

- 定向验证：`node --import tsx --test tests/unit/index.test.ts tests/unit/diagnostics-command.test.ts`：退出码 0，5 项通过。

验收标准：描述和自然语言报告符合英文清单；现有命令、参数、事件属性顺序与 JSON 协议保持原样；测试通过。

### S6：诊断时间迁移脚本

- [x] 应用 M1—M8，同步既有错误断言。
- [x] 通过现有 CLI 子进程测试验证英文 usage、stderr 与退出状态。
- [x] 复用临时 SQLite 验证版本拒绝、备份保护、事务、幂等及回滚。
- [x] 验证成功 JSON 字段保持原样。

参数错误示例：

```text
输入：npm run diagnostics:migrate-time -- --invalid
脚本 stderr：Usage: npm run diagnostics:migrate-time -- --database <existing-database> --backup <new-backup-file>
脚本退出码：1
```

- 定向验证：`node --import tsx --test tests/unit/diagnostics-time-migration.test.ts`：退出码 0，5 项通过。

验收标准：脚本自有文案为英文；迁移语义与数据安全测试通过。验证只使用临时数据库，不执行实际使用者数据库迁移。

### S7：真实冒烟脚本自有输出

- [x] 应用 S1—S44，保留已有英文报告标签。
- [x] 同步外部 Pi 解析错误的既有断言。
- [x] 保留 PI_BIN、PATH、Windows launch、外部 SDK 校验与退出码行为。
- [x] 保留 growth 中文素材、split 双摘要素材及模型指令。
- [x] 回归 S1/S2 已调整的英文消息消费条件。
- [x] 使用现有可导入函数和 CLI 边界验证错误；不为测试字符串抽取转发 helper 或公开内部 RPC handler。

定向验证：

```bash
node --import tsx --test tests/unit/smoke-script.test.ts
```

验收标准：自有脚本消息为英文，现有英文报告字段保持原样，解析与 fixture 测试通过。完整 RPC 事件消费由 S10 的真实场景验证，不能仅以单元测试通过代替。

### S7 验证记录

- 状态：已完成。
- 生产实现：`scripts/smoke-real-pi.ts` 的自有错误、超时、环境校验、状态解析、RPC 解析和失败现场提示均采用批准的英文文案；既有英文报告标签保持原样。
- 保留内容：PI_BIN、PATH、Windows launch、外部 SDK 校验、退出码行为、growth 中文工具素材、split 双摘要素材和模型指令保持原样。
- 测试同步：更新本地仓库 `node_modules` 拒绝场景的英文断言；成功与失败检测继续匹配 S1/S2 文案。
- 定向验证：`node --import tsx --test tests/unit/smoke-script.test.ts`：退出码 0，7 项通过。
- 验收边界：完整 RPC 事件消费、真实 provider 场景和默认 TUI 布局留在 S10。

### S8：汇合与文档同步

- [x] 确认 S1—S7 均通过各自定向验证，处理并行分片的组合断言。
- [x] 修改 `docs/DESIGN.md` 的虚拟 compaction 展示说明：TUI 原生工作消息、英文样例、RPC 状态与取消清理。
- [x] 核对后台预压缩、诊断命令、迁移脚本和验证范围章节，按最终行为更新必要内容。
- [x] 在 `docs/CODE_STYLE.md` 现有 UI/输出与测试章节补充单处提示、自有英文输出及对应验证要求。
- [x] 检查 README 现有命令与示例是否仍有效，仅修正实际失效内容。
- [x] 就地替换失效说明，长期文档只描述当前确定的行为，进度继续保存在本文件。
- [x] 核查无新增 docs 文件、无导航变更、无无关格式整理。

### S8 验证记录

- 状态：已完成。
- `docs/DESIGN.md`：将虚拟 compaction 前台等待说明更新为 Pi 原生 `Working` 工作消息，加入批准的英文进度样例，保留 RPC `setStatus("pi-press", text)`、清理和取消语义。
- `docs/CODE_STYLE.md`：补充 TUI/RPC/非交互模式的进度通道、生命周期和英文输出规则；事件职责表与 UI 约束保持一致。
- `README.md`：现有命令和配置示例仍与实现一致，无需修改。
- 内容检查：未发现旧中文前台进度样例、双位置 UI 说明或新增 docs 文件；未修改文档导航和无关格式。

验收标准：文档与实现一致；英文输出规则与中文代码注释规则各自清楚；正文语言保持现有约定。

### S9：全量检查与变更复核

- [x] 执行 `npm run typecheck`。
- [x] 执行 `npm test`。
- [x] 检查所有待修改文件的 diff，验证本计划第 5 节三类范围。
- [x] 复核稳定技术标识、通知触发与级别、取消/timeout/epoch 清理和脚本消费条件。
- [x] 核对附录 A；使用中文字符串检索辅助查漏，并逐条区分注释、fixture、上游原文与自有固定文案。
- [x] 确认没有通过全仓禁用中文误改测试数据或使用者内容。
- [x] 按用户可见行为变更执行代码评审；发现问题后修复并重跑受影响分片及必要全量检查。
- [x] 记录命令、退出码、失败情况与尚待真实验证的项目。

### S9 验证记录

- 状态：已完成。
- `npm run typecheck`：退出码 0。
- `npm test`：第一次运行 183 项通过、1 项并发集成测试失败；失败用例单独重跑通过，第二次完整运行退出码 0，184 项通过。补充 23 项进度验证及评审修正后的最终完整运行退出码 0，207 项通过，耗时 17.388 秒。
- 最终 `npm run typecheck`：退出码 0。
- 评审修正：重试耗尽后停止刷新进度，测试确认可见序号严格为 1、2、3，实际调用保持一次初始尝试加三次重试。C5、S36 的空格与批准表格一致，诊断示例和断言同步。新增断言先失败，再通过全量回归。
- 评审结果：生产代码只保留中文注释；smoke growth 中文素材、模型指令、测试 fixture 和稳定协议标识保持原样。未发现残留自有中文运行时文案、旧 TUI 进度样例或重复 footer 状态写入。
- 差异检查：`git diff --check` 通过；变更集中在 runtime、配置、诊断、迁移、smoke、相关测试、设计文档和任务记录，未修改依赖清单、导航或系统配置。
- 真实 provider、默认 TUI spinner/布局、窄终端显示和 basic/growth/split 完整 RPC 消费的独立证据见 S10。

这些检查覆盖全仓类型与现有单元/集成行为，不调用真实 provider。验收标准：全量检查通过，变更范围可解释，评审问题已处理；此时仍不能宣称真实 TUI 与 provider 验收通过。

### S10：真实 Pi 与最终验收

- [x] 解析仓库外部的 Pi 可执行文件，记录版本、当前模型和实际场景参数。
- [x] 串行执行 basic、growth、split 场景。
- [x] 通过默认 Pi TUI、仅加载 `pi-press` 验证 spinner、单处文案、计时、重试、完成与取消恢复。
- [x] 验证窄终端中的显示遵循 Pi 原生截断机制，不额外创建状态行或接管编辑器。
- [x] 汇总真实冒烟与默认 TUI 的独立证据。
- [x] 若真实验证导致代码调整，返回对应分片，再执行相关回归和必要全量检查。
- [x] 最终核对待办项与实际验证结果，完成交付记录。

真实调用命令：

```bash
npm run test:smoke:pi
```

以上默认运行 basic。growth 和 split 继续使用相同 npm 命令，并分别设置 `PI_SMOKE_SCENARIO=growth`、`PI_SMOKE_SCENARIO=split`。按实际 shell 设置环境变量，每个场景结束后恢复原有环境值；不修改持久系统配置。模型思考设置沿用脚本既有默认值，除非实际失败表明需要检查已有 inherit 分支。

验收标准：

- basic：英文成功通知被识别，checkpoint 复用、正式 compaction 与 tokensBefore 校验通过。
- growth：英文前台等待被识别，多代 checkpoint、parentCheckpointId、尾部及最终正式压缩校验通过。
- split：双摘要场景及共享成功/失败消费条件有效，正式结果与 checkpoint 匹配。
- 每次报告包括 Pi 可执行文件、Pi 版本、模型、checkpoint token、尾部 token、正式 `tokensBefore` 和退出结果。
- 默认 TUI 仍有原生旋转动画；工作消息展示英文进度；footer 没有同一条压缩进度；完成/取消后恢复正常。
- RPC 测试不替代实际 TUI 验收。若当前工具环境不能观察真实 TUI，则明确记录该项待验证并保持 S10 未完成。
- Pi 不可用、认证失败、正式 compaction 不匹配均按失败处理，不使用仓库本地 Pi 替代。

### S10 真实冒烟记录

- 外部 Pi：`C:/Users/qidi.chen/.pi/agent/install/releases/1.5.0/node_modules/.bin/pi.cmd`，版本 `1.5.0`。各场景使用命令级 `PI_BIN`，仓库本地 Pi、依赖与持久系统配置保持原样。
- basic：`sub2apix/gpt-6.1-sol`，主会话 off、摘要 low，14.893 秒，退出码 0。checkpoint `1bf18b74-4e11-466f-b678-e0b5a589426e`，`15462 + 11 = 15473`，正式值 `15473`。
- split：`sub2apix/gpt-6.1-sol`，主会话 xhigh、摘要 low，34.283 秒，退出码 0。checkpoint `aa263aad-97d0-422b-a980-bcf45349a55b`，`142534 + 14 = 142548`，正式值 `142548`。双摘要校验通过。
- growth 初次后台运行收到 Windows 中断码 `3221225786`；前台重跑退出码 1，480 秒 watchdog 超时。会话证据表明主模型拒绝 `reasoning.effort=none`，首轮请求 HTTP 400，checkpoint 数为 0。脚本既有状态机未识别普通 assistant 请求错误，最终等待到总超时。失败目录为 `C:/Users/QIDI~1.CHE/AppData/Local/Temp/pi-press-real-smoke-CiqsdU`。
- growth 使用已有 `PI_SMOKE_MODEL=sub2apix/gemini-3.8-flash-high` 重跑，主会话 off、摘要 low，36.040 秒，退出码 0。checkpoint `a7c99086-0ed9-4733-bd3a-d67a6e0965b3`，`75498 + 26797 = 102295`，正式值 `102295`。两代 checkpoint，parentCheckpointId 校验通过，观察到 0—7 秒英文前台等待，结果 `recovered_and_formalized`。
- 执行次序：basic → growth 失败 → split → growth 兼容模型重跑；各真实场景之间保持串行。
- 保持原样：本次仅翻译脚本固定文案与同步识别条件。provider 的 thinking 支持范围及既有普通请求失败处理属于额外行为调整，当前通过已有模型参数验证，无新增脚本行为。
- basic 最终复验：`sub2apix/gpt-6.1-sol`，主会话 off、摘要 low，88.798 秒，退出码 0，`Result: PASS`。checkpoint `2e51c2f4-9698-498f-9f19-ede2bc765839`，`16714 + 14 = 16728`，正式值 `16728`。完整日志与退出码分别为 `%TEMP%/pi-press-delivery-final.log`、`%TEMP%/pi-press-delivery-final.result.json`。
- basic 复验前一次调用已输出 PASS（`16724 + 14 = 16738`），工具等待在 60 秒超时，未取得该次 shell 退出码。最终复验使用后台记录方式，取得上述完整退出结果。
- 状态：S0—S10 全部完成，验收状态 `ready`。代码、联动断言与当前文档已同步，新增代码抽象仅为测试夹具，生产公开 API 保持原样。

### S10 默认 TUI 验收记录

- 环境：外部 Pi `1.5.0`，启动其 `dist/bundle/cli.js`。ConPTY 提供真实终端，xterm headless 解析屏幕。通过隔离 `PI_CODING_AGENT_DIR`、`--no-extensions --extension <仓库>/src/index.ts` 仅加载 `pi-press`。所有配置与会话位于临时目录。
- 正常完成：真实模型 `sub2apix/gpt-6.1-sol`，20.511 秒。101 个进度采样每屏均只有一处文案，观察到原生 spinner 的 10 种动画帧、跨秒计时及 100 → 40 → 100 列显示。进度完成后观察到原生 `Working`，随后响应 `TUI_OK`，产生正式 compaction，编辑器恢复空闲。证据：`%TEMP%/pi-press-tui-success.json`。
- Esc 取消：真实模型相同，9.350 秒。19 个采样均为单处进度，发送 Esc 后进度清除并恢复空闲编辑器。宿主返回 `This operation was aborted`，保留原文。证据：`%TEMP%/pi-press-tui-cancel.json`。
- 可见重试：真实 Pi 使用隔离的本地测试 provider `tui-fixture/progress`，前三次请求返回受控 HTTP 400，第四次返回摘要，第五次返回正式回答。10.398 秒，40 个采样均为单处进度，依次观察到 `retry 1/3`、`retry 2/3`、`retry 3/3`，随后恢复 `Working`、正式 compaction 和空闲编辑器。该受控场景用于验证显示，外部 provider 的正确性由上述真实冒烟独立验证。证据：`%TEMP%/pi-press-tui-retry.json`。
- 窄终端：使用 Pi 默认 TUI 模式及同一受控 provider，10.591 秒，100 → 28 → 100 列。28 列的 16 个采样均只有一处 `pi-press: Compacting`，尾部由原生组件截断。恢复 100 列后出现一个终端重排采样，时间在 resize 后约 115 毫秒，下一采样恢复单处；其余 22 个 100 列采样均为单处。最终 compaction 与编辑器恢复通过。证据：`%TEMP%/pi-press-tui-narrow.json`。
- 清理：临时生产探针 `PI_PRESS_TUI_PROBE` 与对应文件写入已移除。临时认证与模型副本已删除，测试 provider 的 HTTP 服务已关闭。ConPTY 辅助进程在强制关闭时输出 `AttachConsole failed`，主流程证据在关闭前写入；进程检查确认没有遗留的测试 TUI 进程。
- 最终验证：`npm run typecheck`、`npm test`、`git diff --check` 均通过。全量测试 207 项通过、0 项失败。未修改重试预算、容量算法、协议标识、数据库 schema、依赖清单、持久配置或发布状态。

## 8. 动态调整与记录规则

- 涉及可测试行为的分片遵循“行为测试先失败 → 最小实现 → 定向验证 → 更新任务状态”的顺序。纯文案替换优先复用现有测试；纯文档分片执行内容自检。
- 已有测试失败、实现不完整或存在未解决错误时，分片保持未完成。
- 发现遗漏文案、联动断言或可观测性缺口时，先补充本文件中的范围、归属、依赖和验收，再继续相关修改。
- 同一目标内的局部测试调整可以自主进行；涉及新的公共契约、额外功能、业务语义或用户已有修改冲突时，先明确差异并取得确认。
- 需要新增生产抽象时，记录当前调用方或失败测试证据。仅用于搬运字符串、改名或转发的抽象保持在范围之外。
- 修改后只重跑受影响分片与必要关联验证。没有新改动或未解决问题时，不重复已经有效的重型验证。
- 环境、安装或真实 provider 失败单独记录，不以跳过测试、切换仓库本地 Pi 或替换假结果解决。
- 对额外耗费较多时间的验证，开始前说明原因、预计耗时和影响范围。真实 provider 调用同时说明场景与费用性质。
- 最终报告区分：已同步修改、仅回归验证、明确保持原样、未完成验证。

### 验证记录模板

每片验收后在此追加简要记录，替换占位符为实际结果：

```text
分片：Sx
状态：未开始 / 进行中 / 阻塞 / 已完成
修改文件：实际文件列表
验证命令：实际执行命令
结果：退出码与必要证据
仅回归范围：实际覆盖范围
未完成项：具体事项或“无”
依赖调整：具体事项或“无”
```

### S0 验证记录

- 状态：已完成。
- `npm ci`：退出码 0；清单和 lockfile 无变更。
- `npm run typecheck`：退出码 0。
- `npm test`：退出码 0，183 项通过。
- 真实 basic：退出码 0，`Result: PASS`，耗时 13.652 秒。
- Pi：`C:/Users/qidi.chen/.pi/agent/install/releases/1.5.0/node_modules/.bin/pi.cmd`，版本 `1.5.0`。
- 模型：`sub2apix/gpt-6.1-sol`，主会话 `off`，摘要 `low`。
- Checkpoint：`06ec4c74-ab14-436c-9f56-08e8ab3cb9d5`；checkpoint token `15462`，尾部 `11`，正式 `tokensBefore=15473`。
- 环境处理：PATH 中的安装器包装器不能定位 SDK；通过本次命令的 `PI_BIN` 指定上述仓库外部 npm shim。后台运行尝试收到控制台中断，前台重跑已通过。未修改系统配置。
- 后续分片：S1 进行中，其余保持未开始。

## 附录 A：已确认英文文案基准

本附录使用占位符表达运行时值。占位符不要求修改现有变量名。模板插值、计数、截断和错误来源处理沿用现有实现。

### A.1 等待进度 P

| 编号 | 英文文案 |
| --- | --- |
| P1 | `pi-press: Compacting · {seconds}s elapsed` |
| P2 | `· retry {count}/3` |
| P3 | `· retry {count}/{limit}` |

### A.2 运行时通知 N

以下 N1—N15 的通知均带 `pi-press:` 前缀，沿用现有通知调用入口；N16 为容量详情片段。

| 编号 | 英文正文 |
| --- | --- |
| N1 | Summary precomputation completed in {seconds}s. |
| N2 | Compaction completed using a precomputed summary. |
| N3 | Compaction completed using Pi's native process. |
| N4 | Background summary precomputation failed: {reason} |
| N5 | No valid compaction boundary is available, and the context exceeds the model's context window. Request stopped. |
| N6 | Foreground compaction timed out, and the context exceeds the model's context window. Request stopped. |
| N7 | Foreground compaction retries were exhausted, and the context exceeds the model's context window. Request stopped. |
| N8 | The context exceeds the model's context window, and summary precomputation is unavailable. Request stopped. |
| N9 | Timed out waiting for the precomputed summary. Background task cancelled. Falling back to Pi's native compaction. |
| N10 | Failed to finalize virtual compaction. At most one retry will be attempted once the session settles. |
| N11 | Virtual compaction finalization failed repeatedly. Pi will handle subsequent requests. |
| N12 | Unable to estimate the precomputed context size. Checkpoint {id} was not saved. |
| N13 | The precomputed context exceeds the capacity limit. Result not saved: {details}. |
| N14 | Unable to estimate the context size for checkpoint {id}. Falling back to Pi's native compaction. |
| N15 | The checkpoint exceeds the capacity limit. Falling back to Pi's native compaction: {details}. |
| N16 | Checkpoint {id}: estimated post-compaction size is {tokens} tokens; hard limit is {limit} tokens |

N1 耗时保留当前一位小数格式。N4 的动态原因来自 F 组或上游异常。N13、N15 的详情使用 N16。

### A.3 失败原因 F

| 编号 | 英文文案 |
| --- | --- |
| F1 | Background summary precomputation timed out (stage: {stage}, requests: {requests}, retries: {retries}) |
| F2 | The model returned an empty or invalid summary |
| F3 | Retries exhausted for transient errors |
| F4 | The model returned a non-retryable error |
| F5 | Background summary precomputation failed |
| F6 | The provider registry for the current model is unavailable |
| F7 | Authentication for the active model is unavailable |
| F8 | The provider for the active model is unavailable |
| F9 | The compaction result failed checkpoint validation or could not be appended |
| F10 | Unknown error |

`stage` 保留 `preparation`、`auth`、`history_summary`、`turn_prefix_summary`、`retry_backoff`、`checkpoint`。

### A.4 诊断命令 C

| 编号 | 英文文案 |
| --- | --- |
| C1 | Query structured diagnostic events for the current or specified session |
| C2 | --session requires a session ID. Usage: {usage} |
| C3 | --last must be an integer from 1 to 100. Usage: {usage} |
| C4 | Unknown argument: {token}. Usage: {usage} |
| C5 | pi-press diagnostics: session ={sessionId}, last {count} events |
| C6 | Database: {location} |
| C7 | in-memory |
| C8 | No matching diagnostic events. |

`{usage}` 保持 `/pi-press-diagnostics [--session <id>] [--last <1-100>] [--json]`。文本事件行继续使用现有时间、事件名和 checkpoint/reason/leaf 属性格式。

### A.5 配置告警 G

| 编号 | 英文文案 |
| --- | --- |
| G1 | Configuration must be a JSON object |
| G2 | Configuration field {field} has been removed. Its value was ignored |
| G3 | Invalid value for configuration field {field}. Using the default value |
| G4 | Unable to read or parse the configuration file |

文件位置包装仍为 `{configPath}: {message}`；主动通知时沿用统一 `pi-press:` 包装。字段名与枚举值保持原样。

### A.6 诊断与存储 D

| 编号 | 英文文案 |
| --- | --- |
| D1 | Full context validation failed: {error} |
| D2 | Virtual context processing failed: {error} |
| D3 | The virtual context exceeds the hard limit. Timed out waiting for a background refresh. |
| D4 | Overflow recovery timed out waiting for an incremental checkpoint. Falling back to Pi's native compaction. |
| D5 | Unable to read the agent's idle state: {error} |
| D6 | The current branch has not reached Pi's compaction boundary. Finalization deferred. |
| D7 | Pi found no content to compact. Finalization deferred. |
| D8 | Virtual compaction finalization failed: {error} |
| D9 | The finalization failure limit was reached. Virtual compaction disabled for the current compaction cycle. |
| D10 | Unable to display the CLI notification: {error} |
| D11 | Unable to prepare the current branch for compaction |
| D12 | Checkpoint {id}: unable to estimate the original context token count |
| D13 | Checkpoint {id}: unable to estimate the post-compaction context size |
| D14 | Diagnostic persistence disabled: {error} |
| D15 | Unable to read SQLite PRAGMA {pragma} |
| D16 | The diagnostics database contains an invalid JSON object |
| D17 | Invalid diagnostic event timestamp |
| D18 | Diagnostics database version {version} exceeds the supported version {supportedVersion} |

持久化错误的空值回退同样使用 F10；原有长度限制与截断后缀保持原样。

### A.7 时间迁移脚本 M

| 编号 | 英文文案 |
| --- | --- |
| M1 | The diagnostics database and backup file must use different locations |
| M2 | The diagnostics database must be an existing file |
| M3 | Timestamp conversion is not supported for diagnostics database version {version} |
| M4 | Diagnostics database backup verification failed |
| M5 | Diagnostic record {id}: at_ms must be a safe integer |
| M6 | Timestamp conversion verification failed for diagnostic record {id} |
| M7 | Record or field verification failed after diagnostics database conversion |
| M8 | `Usage: npm run diagnostics:migrate-time -- --database <existing-database> --backup <new-backup-file>` |

成功 JSON 保留 `databasePath`、`backupPath`、`totalRows`、`convertedRows` 字段。

### A.8 真实冒烟脚本 S

本组 S 编号表示文案编号，与分片 S0—S10 通过所在章节区分。

| 编号 | 英文文案 |
| --- | --- |
| S1 | The live Pi smoke test will call the currently configured provider. |
| S2 | Failed test artifacts preserved at: {directory} |
| S3 | PI_BIN is not executable: {file} |
| S4 | PI_BIN must point outside the repository's node_modules: {file} |
| S5 | No Pi executable was found outside the repository. Install Pi or set PI_BIN |
| S6 | Failed to read the Pi version: {error} |
| S7 | exit code {code} |
| S8 | Pi did not return a version number |
| S9 | The live Pi test must use an SDK outside the repository's node_modules |
| S10 | Unable to locate @earendil-works/pi-coding-agent from the Pi executable: {file} |
| S11 | The external Pi package does not declare a pi CLI: {directory} |
| S12 | The Pi CLI is outside its package directory: {file} |
| S13 | Pi did not create a smoke test session file |
| S14 | Pi did not create a growth smoke test session file |
| S15 | The live Pi session is missing a valid pi-press checkpoint |
| S16 | The live Pi session is missing an extension-generated compaction entry |
| S17 | Summary thinking level mismatch: {level} |
| S18 | The large-input smoke test did not produce the two native split-turn summaries |
| S19 | Invalid snapshot boundary between the compaction entry and checkpoint |
| S20 | tokensBefore mismatch: expected {expected}, got {actual} |
| S21 | The compaction entry was not produced by the extension hook |
| S22 | The compaction entry does not match the checkpoint ID |
| S23 | Timed out waiting for live Pi compaction{details} |
| S24 | Unable to read the live Pi state |
| S25 | No model is available in the current live Pi configuration |
| S26 | The live Pi model information is incomplete |
| S27 | Main session thinking level mismatch: {level} |
| S28 | Live Pi background summary precomputation failed: {message} |
| S29 | Unknown provider error |
| S30 | Live Pi provider request retries exhausted: {error} |
| S31 | Live Pi could not return session entries |
| S32 | Live Pi returned invalid session entries |
| S33 | Unknown extension error |
| S34 | Live Pi extension error: {message} |
| S35 | Non-JSON RPC output: {text} |
| S36 | Live Pi exited early: code ={code} signal ={signal}{details} |
| S37 | The live Pi smoke test produced no result |
| S38 | Timed out waiting for the live Pi continuous Chinese context growth test{details} |
| S39 | Live Pi growth test summary precomputation failed: {message} |
| S40 | The continuous Chinese context growth test did not trigger multiple checkpoint generations: got {count} |
| S41 | The latest checkpoint in the continuous Chinese context growth test is missing parentCheckpointId |
| S42 | The continuous Chinese context growth test observed no foreground wait status updates after the limit was exceeded |
| S43 | The live Pi growth smoke test produced no result |
| S44 | PI_SMOKE_SCENARIO must be basic, split, or growth. PI_SMOKE_SUMMARY_THINKING must be low or inherit |

带 `{details}` 的消息保留原来的可选 stderr/RPC trace 结构，中文连接标点改为英文。现有输出的换行、stdout/stderr 渠道和退出状态保持原样。

### A.9 已有英文与稳定标识

以下自然语言字面量保持原样：

```text
Precompute Pi compaction summaries in the background and reuse them when compaction starts.
Provider authentication was aborted
The operation was aborted
Pi-press background task timed out
Empty summary response (server_error)
Nothing to compact (session too small)
```

以下冒烟报告标签保持原样：

```text
Pi executable
Pi version
Scenario
Summary setting
Model
Main thinking
Elapsed ms
Summary thinking
Checkpoint ID
Checkpoint tokensBefore
Tail tokens
Expected tokensBefore
Formal tokensBefore
Capacity limits
Checkpoint generations
Foreground wait observed
Foreground wait elapsed ms
Foreground wait statuses
Turn telemetry
Growth outcome
RPC events
Result: PASS
```

所有事件名、原因码、状态枚举、JSON 字段以及上游错误原文按实际值保留。原始内容中的中文不能仅因统一扩展文案而翻译。
