# 发布流程

## 1. 确认版本

将以下命令中的 `X.Y.Z` 替换为本次版本。版本号遵循 Semantic Versioning；修复递增 PATCH，兼容功能递增 MINOR，破坏性变更递增 MAJOR。

## 2. 检查发布范围

```bash
git status --short --branch
git pull --ff-only origin main
git log --oneline "$(git describe --tags --abbrev=0)"..HEAD
git diff --stat "$(git describe --tags --abbrev=0)"..HEAD
```

## 3. 更新发布文件

- `package.json` 和 `package-lock.json`：更新 `version`。
- `CHANGELOG.md`：归档 `Unreleased`、填写发布日期、更新比较链接。
- `README.md`：更新固定版本示例。
- 行为或契约变化涉及的 `docs/*.md`：同步修改。

## 4. 发布前检查

```bash
npm whoami
npm config get registry
npm view '@sunnyx11/pi-press@X.Y.Z' version
git diff --check
npm publish --dry-run --access public
```

候选版本查询应返回 `E404`；registry 应为 `https://registry.npmjs.org/`；dry-run 必须通过类型检查、测试和发布文件检查。

## 5. 提交并推送

```bash
git add CHANGELOG.md README.md docs package.json package-lock.json
git commit -m 'chore(release): 发布 X.Y.Z'
git push origin main
```

## 6. 创建并推送标签

```bash
git ls-remote --exit-code --tags origin 'refs/tags/vX.Y.Z'
git tag -a 'vX.Y.Z' "$(git rev-parse HEAD)" -m '发布 X.Y.Z'
git show 'vX.Y.Z' --no-patch
git push origin 'vX.Y.Z'
```

远端标签查询应无输出并返回状态码 `2`。

## 7. 发布 npm

```bash
npm publish --access public
```

## 8. 发布验证

```bash
test "$(npm view '@sunnyx11/pi-press@X.Y.Z' version)" = 'X.Y.Z'
test "$(npm view '@sunnyx11/pi-press' dist-tags.latest)" = 'X.Y.Z'
test "$(git ls-remote --heads origin refs/heads/main | cut -f1)" = "$(git rev-parse HEAD)"
test "$(git ls-remote --tags origin 'refs/tags/vX.Y.Z^{}' | cut -f1)" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
```
