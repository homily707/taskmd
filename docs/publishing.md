# npm 发布与 DSH 更新

taskmd 保留 GitHub 源码和 Git 直装方式，同时以 npm Registry 作为推荐安装渠道。
使用 DSH 插件管理器从 npm 安装的版本，可以使用 DSH 内置的 Registry 版本检查与更新界面；Git 直装不会自动转换成 npm 安装来源。

## 首次发布（只做一次）

1. 确认 npm 包名 `taskmd` 可以使用，或确认自己有该包的发布权限：
   `npm view taskmd version --registry=https://registry.npmjs.org`。如果被其他维护者占用，不要尝试发布；改名会同时涉及 DSH 插件身份及 Client bundle id，需要另行处理。
2. 合并 `.github/workflows/publish.yml` 后，从 main 检出准备发布的版本。使用 Node.js 24，运行 `pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm test`、`pnpm build` 和 `npm pack --dry-run`。
3. 登录你自己的 npm 账号：`npm login --registry=https://registry.npmjs.org`。如果 npm 上还没有该包，先手动执行一次 `npm publish --access public --registry=https://registry.npmjs.org`，创建 `taskmd` 包。仅发布尚未发布过的版本；包名和版本已存在时不得覆盖。
4. 在 npm 网站的 **taskmd → Settings → Trusted publishing** 添加 GitHub Actions publisher：
   - **Organization or user**: `homily707`
   - **Repository**: `taskmd`
   - **Workflow filename**: `publish.yml`
   - **Environment**: 留空
   - **Allowed actions**: 启用直接 **npm publish**（不要仅允许 staged publishing）
   
   发布工作流使用 GitHub OIDC，不需要添加 `NPM_TOKEN`。npm 的可信发布配置应在创建后及时通过一次新版本发布验证。

## 后续发布

1. 在 main 更新 `package.json` 的 `version`（例如 `0.5.1` → `0.5.2`）。
2. 运行 `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm build`，提交 `package.json` 和生成的 `lib/index.js`、`lib/client.js`（如果有变更）。
3. 推送 main，然后为**已经推送的发布提交**创建版本 tag：
   
   ```bash
   VERSION="$(node -p "require('./package.json').version")"
   git tag "v$VERSION"
   git push origin "v$VERSION"
   ```
   
4. GitHub Actions 的 **Publish to npm** 工作流会验证 tag 与版本一致、安装锁定依赖、执行类型检查和测试、构建、确认构建产物已入库、检查 npm 包内容，然后执行 `npm publish`。同一版本不能重复发布；不要复用或强推已发布的 tag。

工作流使用 GitHub-hosted runner、Node.js 24、npm Trusted Publishing。npm 需要 Node >= 22.14 和 npm >= 11.5.1；Node 24 随附的 npm 通常满足要求，实际运行以 Actions 日志为准。

## DSH 用户如何更新

新用户在 DSH **插件管理器**按 Registry 包名 `taskmd` 安装。此后在插件详情的 **版本 / 检查更新** 中发现和安装新版本。检查需要用户主动触发，并非后台自动更新。

从 `github:homily707/taskmd` 安装的旧用户仍属 Git 安装：需按 DSH 插件管理器流程切换到 Registry 安装，不能期待 DSH 自动改变安装来源。迁移前应备份当前 DSH profile 配置及 `data/taskmd/` 中的本机会话绑定信息；Home 中的 Markdown 任务目录与插件包分离。迁移后检查 Home 与 Session 绑定是否正常。

## 发布说明

- npm 的 Trusted Publisher 必须与上述 GitHub owner、仓库及工作流文件名一致。
- 首次创建 npm 包通常需要账号登录发布；尚未创建的包无法预先在 npm 包设置中配置可信发布。
- 工作流只由 `v<package.json 版本>` 格式的 tag 触发，不因日常 push 到 main 发布。
- npm 的 Registry 版本检查与 GitHub 分支更新是两套不同机制。
