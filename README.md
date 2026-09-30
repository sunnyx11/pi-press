# pi-press

`pi-press` 是一个面向 Pi 的 TypeScript 扩展，在上下文接近压缩阈值时提前在后台生成摘要。

## 功能与取舍

- 后台生成摘要，当前 agent 继续运行。
- 后续请求复用摘要和近期消息，并按新增历史刷新检查点。
- 保留原始会话记录，正式压缩和会话恢复使用 Pi 原生实现。

预压缩可能产生额外的 provider 请求和 token 消耗。摘要不可用时使用 Pi 原生压缩。

## 安装

运行要求：

- Node.js `>=22.19.0`
- Pi coding-agent `>=0.87.0`
- 已配置可用的模型和 provider

```bash
# 安装最新版本
pi install npm:@sunnyx11/pi-press

# 固定安装指定版本
pi install npm:@sunnyx11/pi-press@0.4.1

# 在当前进程中临时加载
pi -e npm:@sunnyx11/pi-press@0.4.1

# 更新未固定版本或卸载
pi update npm:@sunnyx11/pi-press
pi remove npm:@sunnyx11/pi-press
```

`pi-press` 是 Pi 扩展包，不提供独立 CLI。Pi 扩展与宿主进程具有相同的系统权限，安装前应检查包来源和源码。

## 配置

配置优先级为：项目配置 > 全局配置 > 内置默认值。

- 全局配置：`~/.pi/agent/pi-press.json`
- 项目配置：`<cwd>/.pi/pi-press.json`

全局目录可以通过 `PI_CODING_AGENT_DIR` 修改。项目配置只需声明需要覆盖的字段。

```json
{
  "precomputeMode": "threshold",
  "softThresholdPercent": 80,
  "summaryThinkingLevel": "low",
  "taskTimeoutMs": 300000
}
```

`summaryThinkingLevel` 只影响后台摘要；设置为 `"inherit"` 可使用主会话思考级别。完整配置见[预压缩设计](https://github.com/sunnyx11/pi-press/blob/main/docs/DESIGN.md)。

## 诊断查询

默认查询当前会话的最近事件。持久化诊断不保存用户消息、完整摘要、工具结果或认证信息。

```text
/pi-press-diagnostics
/pi-press-diagnostics --session <session-id> --last 50
/pi-press-diagnostics --session <session-id> --last 100 --json
```

## 开发

```bash
npm install
pi -e ./src/index.ts
npm run typecheck
npm test
npm run test:smoke:pi
```

`npm run test:smoke:pi` 使用当前环境安装的 Pi 和当前配置模型，可能产生真实 provider 调用费用。详细开发与验证要求见[代码规范](https://github.com/sunnyx11/pi-press/blob/main/docs/CODE_STYLE.md)。

## 相关文档

- [变更记录](CHANGELOG.md)
- [预压缩设计](https://github.com/sunnyx11/pi-press/blob/main/docs/DESIGN.md)
- [代码规范](https://github.com/sunnyx11/pi-press/blob/main/docs/CODE_STYLE.md)

## 致谢

感谢 [LINUX DO](https://linux.do/) 社区。

## 许可证

本项目使用 [MIT License](LICENSE)。
