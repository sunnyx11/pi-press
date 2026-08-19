# pi-press

`pi-press` 是一个面向 Pi 的 TypeScript 扩展，在上下文接近压缩阈值时提前在后台生成摘要。

检查点可用后，provider 请求使用“摘要 + 当前未压缩尾部”的虚拟上下文。

当前 agent 运行结束后，再由 Pi 写入正式 compaction entry。

## 功能与取舍

- 后台生成摘要，不阻塞当前 agent。
- 虚拟上下文只影响当前 provider 请求，不修改 Pi 内部消息或原始 session entry。
- 正式压缩、上下文重建、session 恢复和分支管理继续使用 Pi 原生实现。
- 同一正式压缩周期内可按增量历史连续刷新检查点，避免长时间工具调用使虚拟尾部持续增长。
- 检查点失效、超过 hard limit 或 provider 请求失败时，使用 Pi 原生压缩。

与 Pi 原生压缩相比，`pi-press` 可以减少正式压缩时等待摘要的时间，但可能产生额外的 provider 请求和 token 消耗，并需要维护额外配置。完整设计和边界规则见[预压缩设计](https://github.com/sunnyx11/pi-press/blob/main/docs/DESIGN.md)。

## 安装

运行要求：

- Node.js `>=22.19.0`
- Pi coding-agent `>=0.84.1`
- 已配置可用的模型和 provider

```bash
# 安装最新版本
pi install npm:@sunnyx11/pi-press

# 固定安装指定版本
pi install npm:@sunnyx11/pi-press@0.2.2

# 在当前进程中临时加载
pi -e npm:@sunnyx11/pi-press@0.2.2

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
  "taskTimeoutMs": 300000
}
```

`softThresholdPercent` 同时用于首次预压缩和后续增量刷新。旧版 `targetPostCompactionPercent` 已移除；配置中仍存在该字段时会记录一次警告并忽略其值。

`precomputeMode` 支持以下取值：

| 值 | 作用 |
| --- | --- |
| `"off"` | 停止后台预压缩和检查点复用。 |
| `"threshold"` | 处理阈值触发的后台预压缩、请求级虚拟上下文和 settled 后正式化。 |
| `"threshold-and-manual"` | 在阈值压缩之外，复用没有自定义指令的手动压缩检查点。 |

完整字段、默认值、校验规则和容量计算见[预压缩设计](https://github.com/sunnyx11/pi-press/blob/main/docs/DESIGN.md)。

## 开发

```bash
npm install
pi -e ./src/index.ts
npm run typecheck
npm test
```

项目入口由 `package.json` 的 `pi.extensions` 指向 `src/index.ts`。扩展结构、生命周期、并发、持久化和测试约束见[代码规范](https://github.com/sunnyx11/pi-press/blob/main/docs/CODE_STYLE.md)。

## 相关文档

- [变更记录](CHANGELOG.md)
- [预压缩设计](https://github.com/sunnyx11/pi-press/blob/main/docs/DESIGN.md)
- [代码规范](https://github.com/sunnyx11/pi-press/blob/main/docs/CODE_STYLE.md)

## 致谢

感谢 [LINUX DO](https://linux.do/) 社区。

## 许可证

本项目使用 [MIT License](LICENSE)。
