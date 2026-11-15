# taskmd

DSH Home 中的任务大纲、Markdown 和关联会话。点击有会话的任务会直接进入最近的会话并打开右侧任务栏；只有没有会话的任务才打开正文。任务行的会话数字、以及整行悬浮都会在右侧列出关联 Session；顶部「活跃会话」汇总所有等你处理、运行中或有新结果的 Session，不受任务绑定限制；没有运行中的会话时默认补上最近使用的 3 个。任务状态由人或 Agent 明确修改，与 Agent 的实时运行状态分开。

## 使用

1. 启用 taskmd，在任务面板设置中选择一个 DSH Workspace 作为 Home。
2. 指定 Home 内的任务目录，默认 `./tasks`。
3. 通过插件 UI 或 `taskmd` Agent 工具创建任务。直接放在任务目录根部的普通手工 Markdown 不会自动导入；把合法任务文档放入 `<tasksDirectory>/inbox/` 会被自动导入，并创建、绑定一个 Session、发送任务快照。
4. 编辑任务正文、调整大纲、切换状态、归档或关联已有 Session。
5. 从任务启动 Session 时，默认选择 Home，也可以选择 **全部 DSH Workspace/repo** 中的任意项目。这个选择不会改变 Home 或任务位置。

创建后的任务是普通 Markdown，可以用 Agent 文件工具或编辑器直接修改。UI 会监听变化，保留尚未保存的正文草稿，并在冲突时显示磁盘上的最新正文。Inbox 文件必须是带完整 frontmatter 的 taskmd 文档；不合法文件会留在 inbox 并显示诊断。Inbox 文档中的相对附件路径按导入后的任务目录解析，请按最终位置书写。

启动 Session 会先保存正文，随后按顺序创建会话、关联任务、应用模型选择、发送固定的任务快照并打开会话。某一步失败后可以从已知的 Session 继续；发送重试保留原 requestId 和正文。创建结果不明时暂停重建，需核对已有会话。

## 文件与规则

任务保存在 `<Home>/<tasksDirectory>/<标题>--<短ID>.md`，文件名以标题开头、用短 ID 区分同名任务；任务身份以 frontmatter 的完整 `id` 为准。Inbox 固定为 `<tasksDirectory>/inbox/`：合法任务文档会被移动到任务目录并创建、绑定一个 Session，随后发送任务快照；移动即一次性领取，重启不会重复创建。内容示例：

```yaml
---
taskmd: 0.3
id: 6ac483f1-fb02-46ef-9fe1-bb7aac86f769
title: 验证登录修复
status: todo
parent: null
order: 1024
archived: false
---
在这里写目标、上下文和验收条件。
```

此示例说明文件格式；创建任务请使用 UI 或 Agent 工具。格式标记用于识别文件，不是来源认证。

- 四种状态为 `todo`、`in_progress`、`done`、`canceled`，独立切换，不级联。
- 修改 `title` 会按新标题重命名 Markdown 文件；任务 `id`、父子关系和 Session 关联不变。
- `parent` 表示大纲层级，不能引用不存在的父级或形成循环。
- `order` 是整数；同级按 order、ID 排序。
- 归档只改变当前任务的标记，普通视图隐藏其子树；恢复不改后代标记。
- 删除任务会级联删除其整个子树，需二次确认；删除清理关联，不删除 DSH Session 或附件文件。
- 一个任务可关联多个 Session；一个 Session 在当前任务空间中最多关联一个主任务，重新绑定会改绑。

任务内容直接读写文件，没有数据库、全局 revision、索引或事务存储层。Home 设置与 Session 绑定保存在当前 DSH profile 的 `data/taskmd/` 本机 JSON 文件中，绑定按规范化 Home/任务目录分区。

更新和删除需要单文件内容哈希 `expectedVersion`。冲突后应重读并合并。写入使用最终版本检查与原子替换，同进程操作串行化；与任意外部进程之间仍有检查和替换的竞争窗口，不提供严格的跨进程 CAS。任务删除与绑定清理也不是跨文件事务。

普通附件直接放在 Home 内，用 Markdown 相对路径引用，例如 `../assets/design.png`。路径以任务文档为基准，规范化后须留在 Home 内。支持安全图片和文本预览，拒绝越界、符号链接逃逸、不支持的类型和超过 8 MiB 的附件。任务文档上限为 1 MiB。

Markdown 阅读器支持标题、段落、列表、代码、强调、链接和图片，是安全的常用语法子集；不执行嵌入 HTML。正文编辑使用文本编辑框。

## Agent 工具

插件启用后，Agent 可调用 `taskmd`：

| action | 用途 |
| --- | --- |
| `list` / `read` | 任务摘要、完整 Markdown、文件路径和版本 |
| `create` / `update` / `delete` | 与 UI 相同的文件操作 |
| `configure` | 设置 Home 与相对任务目录 |
| `bindings` / `bind` / `unbind` | 查询与修改本机会话关联 |
| `attachment` | 读取任务中的相对附件 |

`update` 的 `changes` 只接受 title、status、parent、order、archived、body。任务创建后可继续使用普通文件工具编辑。工具不隐式创建或向 Session 发消息。

## 边界

当前实现不兼容旧数据字段，也不自动迁移旧任务。移除了 task graph、依赖边、Ready、repo 字段、Asset 实体和独立 Web 入口。旧任务目录不会因安装 taskmd 而被改写。

需要 DSH `>=0.2.2-rc.3 <0.3.0`、Node.js 22 及以上。当前开发依赖与 DSH 0.2.2-rc.3 对齐。

## 开发与验证

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm peers check
```

构建只生成 `lib/index.js`（Host）与 `lib/client.js`（Client），两个 bundle 随仓库分发。修改源码后必须构建；正在运行的 DSH 是否已重载需单独确认。安装、启用和更新使用 DSH 的 plugin_manager。

Host 的 Cordis、DSH 协议及工具包由宿主提供；Client 的 React 和 client-store 使用宿主共享模块。`pnpm-workspace.yaml` 为已发布 client-store 中仅列作开发依赖的 Zustand/Immer 补足 Node 测试依赖，没有把这些副本打进 Client。

测试在独立临时目录中覆盖文件冲突、结构约束、附件路径、监听、绑定隔离、UI 草稿、工作区选择、Session 启动续接和 Agent 工具。自动化测试与浏览器实机验收应分别记录。
