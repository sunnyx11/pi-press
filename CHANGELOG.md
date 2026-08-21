# Changelog

本文件记录项目中所有值得注意的变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/spec/v2.0.0.html)。

## [Unreleased]

### Changed

- settled 后正式化通过 Pi 公开的 `SettingsManager` 获取当前 `compaction.keepRecentTokens`，该值只在 Pi settings 中配置；字段缺失时使用 Pi 默认值。
- checkpoint preparation 固定保留 10000 token 的近期原始消息，preparation 算法版本为 3；v4/algorithm 2 checkpoint 不作为当前 checkpoint 使用。
- settled 后正式化在调用 `ctx.compact()` 前模拟 Pi 原生 preparation；会话尚不足以压缩时按叶节点延期，不产生 warning 或正式化失败计数。

## [0.3.0] - 2026-08-19

### Added

- 支持同一正式压缩周期内连续生成增量 checkpoint；每一代继承 parent 摘要并处理后续历史，长时间工具调用无需等待 agent 结束即可持续缩短虚拟上下文。
- `agent_settled` 会等待兼容的后台任务并正式消费最新 checkpoint；overflow 恢复也可等待并复用比失败请求更新的 checkpoint。

### Changed

- 首次预压缩和后续增量刷新统一使用 `softThresholdPercent`，达到阈值时启动下一代 checkpoint。
- checkpoint 持久化格式升级为 v4 并校验完整 parent 序列；现有 v3 checkpoint 仍可作为增量序列的根节点使用。
- 虚拟上下文投影增量缓存分支消息标识、token 和 checkpoint 边界，减少长会话中的重复映射计算。

### Removed

- 移除公开配置字段 `targetPostCompactionPercent`。旧配置中的该字段会记录一次警告并被忽略；请改用 `softThresholdPercent` 控制首次预压缩和后续刷新。

## [0.2.2] - 2026-08-11

### Fixed

- 保留虚拟上下文的 checkpoint 刷新请求，确保后续 `turn_end` 能够生成刷新 checkpoint。
- 虚拟上下文超过 hard limit 时，有界等待正在生成的刷新 checkpoint；等待超时后保留原消息。
- 正式化失败后释放 checkpoint claim，使下一次 `agent_settled` 能够重试一次。

## [0.2.1] - 2026-08-11

### Fixed

- 修复其他 `context` 扩展转换或注入消息时的虚拟 checkpoint 兼容：保留已转换和注入的消息，将额外 token 纳入容量校验，并在映射不明确或处理异常时返回原上下文。

## [0.2.0] - 2026-08-10

### Added

- 在公开 `context` 事件中应用 checkpoint 的虚拟 `compactionSummary` 和当前未压缩尾部，并在 hard limit、边界映射不明确或 checkpoint 失效时回退原消息。
- 在 `agent_settled` 后延迟调用 `ctx.compact()`，由 Pi 写入正式 compaction entry、重建 agent state，并支持 native compaction 优先、失败重试和 session resume。
- 根据已应用虚拟 checkpoint 的尾部容量刷新后台 checkpoint，避免虚拟 provider usage 低于软阈值时遗漏增长。

### Changed

- 将默认 `targetPostCompactionPercent` 从 50 调整为 60，减少虚拟上下文与正式 checkpoint 复用之间的容量阈值差异。

## [0.1.0] - 2026-08-09

### Added

- 上下文使用量达到可配置阈值后，在后台生成 Pi compaction 摘要，并在持久化成功后显示结果。
- 通过 Pi 扩展 API 持久化带版本的预压缩 checkpoint；正式 compaction 仅复用通过 schema、session、正式 compaction epoch、分支祖先和预计压缩后容量校验的结果。
- 支持全局和项目配置，控制调度阈值、任务超时、正式压缩等待时间和容量目标，并在配置无效时按字段使用默认值。
- preparation、provider、checkpoint、容量或生命周期条件不满足时回退 Pi 原生 compaction，并通过 Pi 通知报告执行错误和容量、等待状态。
- 后台任务覆盖 preparation、认证和 provider 请求的总超时，并限制多个 Runtime 实例及 reload 后重新导入的模块实例同时发起重复请求。

### Security

- 认证错误和 provider 凭据不会写入通知、诊断或 checkpoint provenance。
- 持久化实际 provider endpoint 前移除 URL user information、query 和 fragment。

[Unreleased]: https://github.com/sunnyx11/pi-press/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/sunnyx11/pi-press/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/sunnyx11/pi-press/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/sunnyx11/pi-press/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/sunnyx11/pi-press/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sunnyx11/pi-press/releases/tag/v0.1.0
