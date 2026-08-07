# pi-press 预压缩设计

## 目的

`pi-press` 用于改善 Pi 原生上下文压缩的等待体验，同时保持 Pi 原生会话格式和上下文语义。

核心目标：

- 上下文使用量达到约 60% 时，在后台提前生成一份原生 compaction 结果。
- 后台任务执行期间，当前 agent 继续运行，不中止当前操作。
- 预先生成的结果持久化到当前 session 的 JSONL 文件。
- Pi 真正触发 compaction 时，复用已生成的摘要，并保留检查点之后尚未压缩的原始消息。
- 正式压缩仍由 Pi 原生 compaction 流程完成，恢复、分支和 TUI 行为继续使用 Pi 的实现。

## 非目标

- 修改 `pi-mono` 核心代码。
- 在当前 provider 请求已经发出后修改该请求的上下文。
- 维护项目级事实文档。
- 引入 observation、reflection、dropper 等独立的长期记忆系统。
- 删除或重写原始 session entry。

## 核心模型

该扩展使用预压缩检查点（pre-compaction checkpoint）。检查点保存一份已经生成的 compaction 结果，以及生成时的会话边界。

```text
上下文达到软阈值
        |
        v
后台执行与 Pi 原生相同的 compaction preparation 和 summary generation
        |
        v
追加预压缩检查点到 session JSONL
        |
        v
主 agent 继续运行并产生新的原始消息
        |
        v
Pi 原生 compaction 触发
        |
        v
读取有效检查点，复用 summary，保留检查点边界之后的原始消息
        |
        v
Pi 追加正式 compaction entry 并重建上下文
```

60% 阶段只生成和保存检查点，不改变当前 agent 的运行时上下文。正式 compaction 发生后，Pi 才通过原生上下文构建逻辑应用该检查点。

## 触发规则

### 后台预压缩

- 监听 `turn_end`，在 agent 仍可能继续运行时检查上下文使用量。
- 优先使用 `ctx.getContextUsage()` 返回的 provider token 使用量。
- 没有 provider usage 时，使用 session source entry 的估算值作为后备。
- 默认软阈值为活动模型上下文窗口的 60%，阈值可配置。
- 同一 session 同时只运行一个后台预压缩任务。
- 后台任务不会调用 `ctx.compact()`，避免中止当前 agent 操作。

### 正式 compaction

- Pi 原生 threshold compaction 和 overflow compaction 保持启用。
- `agent_end` 之后可以由扩展执行主动 compaction，但只在 agent idle 时调用 `ctx.compact()`。
- Pi 原生 compaction 进入 `session_before_compact` 时，扩展尝试复用最近的有效检查点。
- 没有有效检查点时，返回 `undefined`，由 Pi 使用原生摘要流程。

## 预压缩检查点 JSONL 契约

扩展通过 `pi.appendEntry()` 追加一类 custom entry。该 entry 默认不会进入 LLM 上下文，只用于持久化预压缩结果。

```json
{
  "type": "custom",
  "customType": "pi-press.precompaction",
  "data": {
    "version": 1,
    "checkpointId": "checkpoint-1",
    "snapshotLeafId": "entry-42",
    "firstKeptEntryId": "entry-18",
    "summary": "...",
    "tokensBefore": 76000,
    "usage": {},
    "model": {
      "provider": "anthropic",
      "modelId": "..."
    },
    "createdAt": "2026-01-01T00:00:00.000Z"
  }
}
```

字段规则：

- `version`：检查点数据版本。
- `checkpointId`：检查点唯一标识。
- `snapshotLeafId`：生成检查点时当前分支的叶子 entry ID。
- `firstKeptEntryId`：摘要之后保留的第一个原始 entry ID。
- `summary`：使用 Pi 原生 compaction 摘要逻辑生成的摘要文本。
- `tokensBefore`：生成检查点时的上下文 token 数，仅作记录；正式 compaction 使用当前 preparation 的值。
- `usage`：摘要请求的 provider usage。
- `model`：生成摘要时使用的模型，用于检查模型变化。
- `createdAt`：检查点生成时间。

原始消息不复制到检查点。原始消息继续由 Pi 的普通 session entry 保存。

## 后台摘要生成

后台任务使用与 Pi 原生 compaction 相同的准备和摘要流程：

1. 读取当前分支 entry。
2. 使用 compaction settings 计算 `firstKeptEntryId`。
3. 序列化需要摘要的旧消息。
4. 调用同一套摘要提示词和模型请求逻辑。
5. 得到 `summary`、`firstKeptEntryId`、`tokensBefore`、`usage` 和 `details`。
6. 将结果包装为 `pi-press.precompaction` custom entry。
7. 在提交前重新检查 session 和分支状态。
8. 状态有效时追加到 JSONL。

后台任务使用独立的 `AbortController`。session 切换、session 关闭或分支状态失效时，任务结果作废。

## 正式 compaction 的复用规则

`session_before_compact` 收到 Pi 当前的 `preparation` 和当前分支 entry 后，按以下顺序选择检查点：

1. 找到当前分支上最近的 `pi-press.precompaction` entry。
2. 确认 `snapshotLeafId` 位于当前分支中。
3. 确认 `firstKeptEntryId` 位于当前分支中。
4. 确认检查点生成时的模型与当前模型兼容。
5. 确认从 `firstKeptEntryId` 到当前叶子的原始消息仍能放入目标上下文预算。
6. 检查通过后，返回扩展提供的 `CompactionResult`。

返回值使用检查点的摘要和边界，但使用当前 compaction preparation 的 `tokensBefore`：

```ts
{
  compaction: {
    summary: checkpoint.summary,
    firstKeptEntryId: checkpoint.firstKeptEntryId,
    tokensBefore: currentPreparation.tokensBefore,
    usage: checkpoint.usage,
    details: {
      type: "pi-press.precompaction",
      version: 1,
      checkpointId: checkpoint.checkpointId
    }
  }
}
```

Pi 核心随后追加正式 `compaction` entry。恢复后的上下文为：

```text
正式 compaction summary
+ firstKeptEntryId 开始的原始消息
+ 正式 compaction entry 之后的新消息
```

预压缩 custom entry继续保留在 JSONL 中，但不进入 LLM 上下文。

## 检查点失效和后备处理

以下情况会使检查点失效：

- 当前 session 已切换；
- 当前分支不再继承 `snapshotLeafId`；
- `firstKeptEntryId` 不在当前分支中；
- 检查点之后的原始消息过多，保留尾部会超过预算；
- 当前模型或 provider 与检查点生成时不兼容；
- 检查点数据校验失败；
- 后台摘要请求失败或被取消。

检查点失效时，扩展返回 `undefined`，由 Pi 原生 compaction 生成摘要。原始 session entry 保持完整。

后台任务在摘要生成后、JSONL 追加前退出时，检查点不会出现；下一次触发重新生成。JSONL 已追加但进程随后退出时，session 恢复会重新读取该检查点。

## 分支处理

后台任务开始时记录 `sessionId`、`snapshotLeafId` 和 `firstKeptEntryId`。

提交前必须确认：

```text
当前 sessionId == snapshot sessionId
当前分支包含 snapshotLeafId
当前分支包含 firstKeptEntryId
```

当前分支只是从快照继续产生新消息时，检查点仍然有效，新消息会作为未压缩尾部保留。当前分支已经切换到其他分支时，旧检查点作废，不能追加到新分支。

## 运行时状态

Runtime 至少维护以下状态：

```text
precompactionInFlight
compactionHookInFlight
sessionId
runGeneration
activeCheckpointId
lastError
```

状态规则：

- 同一 session 只允许一个后台预压缩任务；
- 同一时间只允许一个 compaction hook 执行；
- session 切换或关闭时递增 `runGeneration`，废弃旧任务；
- 后台任务失败后清除 in-flight 状态；
- 检查点追加成功后更新当前检查点 ID；
- 正式 compaction 完成后，下一轮预压缩从最新 native compaction 边界继续准备。

## 验收标准

1. 上下文达到 60% 后，后台开始生成检查点，当前 agent 不被中止。
2. 检查点作为 `pi-press.precompaction` entry 出现在 session JSONL。
3. 后台摘要使用 Pi 原生 compaction 的 preparation、序列化和摘要提示词。
4. Pi 真正 compaction 时，扩展能复用有效检查点，不再重复请求摘要模型。
5. 正式 compaction entry 由 Pi 核心写入，包含正确的 `firstKeptEntryId` 和当前 `tokensBefore`。
6. 正式 compaction 后，上下文包含预压缩摘要和检查点之后的原始消息。
7. session 重启后可以从 JSONL 恢复并识别有效检查点。
8. 分支切换后，旧分支检查点不会写入新分支。
9. 检查点失效或后台任务失败时，Pi 原生 compaction 仍然可以工作。
10. 连续多次 compaction 不会重复写入同一检查点或并发执行多个后台摘要任务。
11. `npm run typecheck` 和 `npm test` 通过。
