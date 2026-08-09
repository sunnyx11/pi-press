# Changelog

本文件记录项目中所有值得注意的变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/spec/v2.0.0.html)。

## [Unreleased]

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

[Unreleased]: https://github.com/sunnyx11/pi-press/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sunnyx11/pi-press/releases/tag/v0.1.0
