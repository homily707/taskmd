# taskmd

DSH Home 中的任务大纲、Markdown 和关联会话。点击有会话的任务直接进入最近的会话并打开右侧任务栏，无会话的任务打开正文。任务状态由人或 Agent 明确修改，与 Agent 的运行状态无关。

## 安装与更新

在 DSH 插件管理器中按 npm 包名 `@homily/taskmd` 安装，更新也在插件管理器里检查版本。也支持 `github:homily707/taskmd` 直装，但不会自动切换成 Registry 更新。需要 DSH `>=0.2.2-rc.3 <0.3.0`、Node.js 22+。

## 使用

1. 启用 taskmd，在任务面板选一个 DSH Workspace 作为 Home，任务目录默认 `./tasks`。
2. 用插件 UI 或 `taskmd` Agent 工具创建任务；从任务启动 Session 时可选择 Home 或任意 Workspace，不影响 Home 和任务位置。
3. 任务是普通 Markdown，可用编辑器或文件工具直接改；UI 会监听变化、保留草稿，冲突时显示磁盘上的最新正文。
4. 把合法任务文档放进 `<tasksDirectory>/inbox/` 会自动导入，并创建、绑定一个 Session（一次性领取，重启不重复）。
5. 从 DSH 官方「新建 Session」进入空白会话后，可在仓库、Agent preset 选项旁使用「＋任务」：选择已有任务直接绑定，或输入标题创建任务并绑定到当前 Session。任务 Prompt 只填入原生输入框供编辑，不自动发送、不创建第二个 Session。对已有草稿使用保守插入；若同时编辑导致插入失效，可在同一入口重试。已有其他关联时，先在 taskmd 侧栏解除。

## 任务文件

路径为 `<Home>/<tasksDirectory>/<标题>--<短ID>.md`；身份以 frontmatter 的完整 `id` 为准，可选 `summary` 供 `taskmd list` 筛选。最小格式：

```markdown
---
taskmd: 0.3
title: 我的任务
---

任务正文。
```

导入时自动生成 `id`，并填充 `status: todo`、`parent: null`、`order`、`archived: false`。

- 状态：`todo` / `in_progress` / `done` / `canceled`，独立切换，不级联。
- 修改 `title` 会按新标题重命名文件，`id`、父子关系和 Session 关联不变。
- `parent` 表示大纲层级，不可引用不存在的父级或成环；同级按 `order`、ID 排序。
- 归档隐藏当前任务及其子树；删除会级联删除整个子树，需二次确认。
- 一个任务可关联多个 Session；一个 Session 在一个任务空间内最多绑定一个主任务，重新绑定会改绑。
- 附件放在 Home 内、用相对路径引用，规范化后须留在 Home 内；支持安全图片/文本预览，附件上限 8 MiB，任务文档上限 1 MiB。

Home 设置与 Session 绑定保存在当前 DSH profile 的 `data/taskmd/` 本机 JSON。更新/删除需 `expectedVersion`，冲突后重读并合并。

## Agent 工具

`taskmd` 工具只保留任务结构与 Session 相关操作；任务正文和元数据的读取/修改由文件工具直接完成，效率更高。

| action | 用途 |
| --- | --- |
| `create` / `delete` | 创建任务 / 级联删除子树（`delete` 可省略 `expectedVersion`，省略时用当前文件哈希） |
| `configure` | 设置 Home 与相对任务目录 |
| `bindings` / `bind` / `unbind` | 查询/修改本机会话关联 |
| `attachment` | 读取任务中的相对附件 |

`read`、`update`、`list` 已从 Agent 工具中关闭（实现仍保留在核心与 UI remote，需要时再打开）。任务正文、`summary` 以及标题、状态、层级、排序、归档等元数据都直接编辑任务 Markdown 文件并保留 frontmatter；工具不隐式创建任务或向 Session 发消息。

## 边界

不兼容旧数据字段，也不自动迁移旧任务；不提供 task graph、依赖边、Ready、repo 字段、Asset 实体和独立 Web 入口。安装不会改写旧任务目录。

## 开发

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm peers check
```

构建生成 `lib/index.js`（Host）和 `lib/client.js`（Client），随仓库分发；改源码后必须构建。Host 的 Cordis、DSH 协议与工具包，以及 Client 的 React、client-store 由宿主提供。发布流程见 [docs/publishing.md](docs/publishing.md)。
