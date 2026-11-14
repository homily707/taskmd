# taskmd

基于 Markdown 的轻量共享工作空间。主要用于在 DSH 中浏览任务大纲、编辑 Markdown、关联 Session，以及查看 Agent 活动状态。

## 核心用法

- 共享目录中的 `tasks/<id>.md` 是文档与任务元数据的事实来源。
- DSH 左侧栏可切换为任务大纲；右侧任务详情提供 Markdown 编辑、状态标记、Session 关联和导航。
- 从任务创建 DSH Session 时，初始化提示词直接包含当前 Markdown 正文。Agent 不需要安装或执行 taskmd CLI。
- 一个任务可以关联多个 Session。关联记录保留在本机，不随 Markdown 同步。
- 任务状态与 Agent 的实时执行状态互相独立。状态变化不会影响子任务，也不会启动或终止 Agent。

## 数据位置

共享目录包含 `tasks/` 和 `assets/`。后者用于兼容旧资源引用；新文档推荐直接在 Markdown 正文中记录常规链接。

本机目录保存 `repositories.json`、`sessions.json`、`instance.json`、索引和事务文件。任务元数据中的 `repo` 是跨设备共享的名称，路径映射由各设备自行配置。

目录仍然通过 `store` 和 `root` 配置：

```bash
taskmd config set store "$HOME/Cloud/taskmd"
taskmd config set root "$HOME/.taskmd"
taskmd init
taskmd repos set backend "$HOME/code/backend"
```

注意：DSH 沙箱不一定能直接访问仓库外的共享目录。从 UI 创建 Session 时会直接附上 Markdown 正文，不需要 Agent 读取共享目录；如果 Agent 需要修改外部文件，仍须为其配置对应的文件访问权限。

## 任务行为

- `todo`、`in_progress`、`done`、`canceled` 都是单独文档的手动标记。
- `archived` 仅用于收纳；归档一个任务会同时隐藏其子树，但不会改变任何执行状态。
- `blocked_by` 是兼容旧文件的信息关联。它不会阻止状态修改、跨层级移动、完成或归档。失效引用仅产生诊断警告。
- `ready` 接口为向后兼容保留，目前仅表示未归档的待办文档，不再代表 Agent 执行许可。
- 删除不再要求先取消、归档或解除信息引用；仍须先移动或删除子任务，避免出现孤立父子结构。删除保留实际共享 Asset 文件和 DSH Session，但解除本机绑定。
- 不允许父子关系循环和无效父节点；写入仍采用版本校验、事务恢复及冲突保护。
- 既有 Markdown frontmatter 字段继续读取，不需要迁移。

## 可选入口

CLI 保留用于手动脚本与诊断，不再是 Agent 的默认工作流程。独立 Web 和关系图仍保留现有功能，但本轮不继续扩展，优先优化 DSH 内的 Markdown 大纲与 Session 体验。

```bash
taskmd list
taskmd tree
taskmd show <id>
taskmd create "文档标题" --repo backend
taskmd check
taskmd serve
```

## 开发

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

**重要：** 仓库包含已构建的 `lib/` 产物。源代码修改后需要执行 `pnpm build` 才会更新 DSH 插件和 CLI 实际使用的 bundle。若未执行构建，旧 bundle 不会体现源代码的改动。

本分支以兼容旧数据为前提减轻业务约束，不改变 Store 底层的版本、冲突和恢复机制。
