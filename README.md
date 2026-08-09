# pi-press

`pi-press` 是一个面向 Pi 的 TypeScript 扩展，用于在上下文接近压缩阈值时，提前在后台生成压缩结果。Pi 触发正式 compaction 时，扩展会尝试复用该结果，从而减少等待时间。

## 项目用途

Pi-press 保留 Pi 原生的 session、分支和正式 compaction 机制，只增加后台预压缩和检查点管理：

- 当前 agent 继续执行，不等待后台摘要请求。
- 预压缩结果通过 Pi 的扩展 API 保存。
- 检查点失效、容量不足或 provider 请求失败时，回退到 Pi 原生压缩。
- checkpoint 持久化完成后才显示成功；认证失败和后台摘要执行失败显示 error，preparation 不可用只记录诊断，容量不足和正式压缩等待超时显示 warning。

## 与原生压缩比较

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| Pi 原生压缩 | 无额外摘要请求；行为由当前 Pi 版本统一管理；无需额外配置。 | 只有正式触发压缩后才开始生成摘要，当前操作可能需要等待。 |
| `pi-press` | 提前生成摘要；正式压缩时通常可以快速复用；后台生成不会中止当前操作。 | 可能产生额外的 provider 请求和 token 消耗；检查点可能因分支、容量或版本变化而失效；需要维护额外配置。 |

Pi-press 不改变原始 session entry，也不手工写入正式 `compaction` entry。完整设计和边界规则见 [docs/DESIGN.md](https://github.com/sunnyx11/pi-press/blob/main/docs/DESIGN.md)。

## 安装与使用

运行要求：

- Node.js `>=22.19.0`
- Pi coding-agent `>=0.84.1`
- 已配置可用的模型和 provider

安装最新版本：

```bash
pi install npm:@sunnyx11/pi-press
```

固定安装首个版本：

```bash
pi install npm:@sunnyx11/pi-press@0.1.0
```

只在当前进程中临时加载：

```bash
pi -e npm:@sunnyx11/pi-press@0.1.0
```

更新未固定版本或卸载：

```bash
pi update npm:@sunnyx11/pi-press
pi remove npm:@sunnyx11/pi-press
```

`pi-press` 是 Pi 扩展包，不提供独立 CLI。Pi 扩展与宿主进程具有相同的系统权限，安装前应检查包来源和源码。

## 配置

### 配置文件

配置按以下顺序合并：

1. 全局配置：`~/.pi/agent/pi-press.json`
2. 项目配置：`<cwd>/.pi/pi-press.json`
3. 内置默认值

项目配置中的同名字段覆盖全局配置，未填写的字段继续继承全局值。全局目录可以通过 `PI_CODING_AGENT_DIR` 修改；同一文件被两个位置指向时只读取一次。

### 示例

```json
{
  "precomputeMode": "threshold",
  "softThresholdPercent": 80,
  "taskTimeoutMs": 300000,
  "targetPostCompactionPercent": 50
}
```

`precomputeMode` 支持以下取值：

| 值 | 作用 |
| --- | --- |
| `"off"` | 停止后台预压缩和检查点复用。 |
| `"threshold"` | 处理阈值触发的自动压缩。 |
| `"threshold-and-manual"` | 在阈值压缩之外，复用没有自定义指令的手动压缩检查点。 |

其他可配置字段包括摘要预留 token、后台任务超时、压缩前等待时间和压缩后目标比例，后台任务总超时默认为 `300000` 毫秒。后台摘要请求固定允许一次瞬时错误重试；预压缩固定保留 `2000` 个近期 token；同一正式 compaction epoch 最多刷新一次 checkpoint，这些值都不作为配置项。完整字段、默认值、校验规则和容量计算见 [docs/DESIGN.md](https://github.com/sunnyx11/pi-press/blob/main/docs/DESIGN.md)。

## 二次开发

安装开发依赖并从源码加载：

```bash
npm install
pi -e ./src/index.ts
```

项目入口由 `package.json` 的 `pi.extensions` 指向 `src/index.ts`。主要职责如下：

- `src/index.ts`：注册 Pi 生命周期事件。
- `src/extension-runtime.ts`：管理 session 状态、后台任务和检查点复用。
- `src/config.ts`：读取并合并全局、项目配置。
- `src/checkpoint/`、`src/compaction/`、`src/provider/`：分别处理检查点、压缩准备和 provider 请求适配。

开发验证命令：

```bash
npm run typecheck
npm test
```

新增功能时应优先使用 Pi 包根入口的公开 API，不手工读取 session JSONL，不手工写入正式 compaction entry。扩展结构、生命周期、并发、持久化和测试约束见 [docs/CODE_STYLE.md](https://github.com/sunnyx11/pi-press/blob/main/docs/CODE_STYLE.md)。

## 相关文档

- [变更记录](CHANGELOG.md)
- [预压缩设计](https://github.com/sunnyx11/pi-press/blob/main/docs/DESIGN.md)
- [代码规范](https://github.com/sunnyx11/pi-press/blob/main/docs/CODE_STYLE.md)

## 许可证

本项目使用 [MIT License](LICENSE)。
