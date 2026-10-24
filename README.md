# taskmd

任务和共享资源可以放在同一个云文件夹；仓库路径映射、会话绑定和运行状态保留在每台机器本地。CLI、独立 Web 服务和 DSH Host 都使用同一个 Store 和配置解析器。

## 一次性配置

CLI 可直接通过源码入口运行，不需要先构建 DSH 插件。安装依赖后，在当前 shell 定义快捷命令：

```bash
alias taskmd='node /absolute/path/to/taskmd/bin/taskmd.mjs'
```

仅有两个持久配置项：

```bash
# 可同步的数据：tasks/ 和 assets/
taskmd config set store "$HOME/Cloud/taskmd"

# 本机数据根目录；默认 ~/.taskmd，可省略此项
taskmd config set root "$HOME/.local/share/taskmd"

taskmd init
taskmd repos set backend "$HOME/code/backend"
taskmd repos set frontend "$HOME/code/frontend"
```

设置以后，从任意工作目录、新开的终端都能使用，不需要每次传路径或设置环境变量。快捷命令本身若需要跨终端保留，可写入 shell 启动配置；也可以直接使用 `node /absolute/path/to/taskmd/bin/taskmd.mjs`。

```bash
taskmd config list                # 生效路径及来源
taskmd config get store           # 只输出路径，适合脚本
taskmd config get root
taskmd config unset root          # 恢复默认本机根目录
taskmd config list --json         # 含 schemaVersion、file、values、sources
```

配置入口固定为 `~/.taskmd/config.json`，内容例如：

```json
{
  "store": "/Users/alice/Cloud/taskmd",
  "root": "/Users/alice/.local/share/taskmd"
}
```

配置入口不跟随 `root` 搬迁，否则下一次启动无法发现新的根目录。配置协调锁也位于固定入口旁，其余本机数据从 `root` 派生。只有 `store` 和 `root` 两个键，未知键会报错；设置时展开 `~` 并把相对路径解析为当前工作目录下的绝对路径。配置保存采用临时文件、同步和原子替换。

`store` 的优先级为：显式 `--store`（或 Host 的显式 store 参数）→ `TASKMD_STORE` → 持久配置 → `<root>/store`。`root` 使用持久配置，否则为 `~/.taskmd`。`config list` 中的来源是 `argument`、`environment`、`config` 或 `default`。如果之前设置过 `TASKMD_STORE`，可执行 `unset TASKMD_STORE` 后再使用持久配置。

`init [directory]` 只初始化指定目录，不修改默认配置。需要记住目录时使用 `config set store`。

## 目录布局

```text
<store>/
├── tasks/<id>.md
└── assets/

<root>/local/<SHA-256(任务库规范化绝对路径)>/
├── repositories.json
├── sessions.json
├── instance.json                # 本机实例标识
├── index.json
├── receipts/
├── pending.json                 # 有待恢复提交时存在
└── writer.lock                  # 操作持锁期间存在

~/.taskmd/
├── config.json
└── config.lock                  # 配置/Store 操作期间存在
```

仓库映射表自动跟随 `root`，没有单独的 `repos-file` 配置。不同任务库的映射、会话和缓存互相隔离。多个仓库的任务使用同一个 `store`，通过任务的 `repo` 名称区分；可以建立跨仓库依赖。

```bash
taskmd create "实现登录接口" --repo backend
taskmd create "实现登录页面" --repo frontend
taskmd list
taskmd tree
taskmd ready
```

每台机器分别登记相同的 repo 名称和各自的路径。`repos set` 只登记一个现有目录，不复制代码、不克隆仓库。任务的 `kind: shared` 资源相对于 `<store>/assets/`；`kind: repo` 资源相对于该机器登记的仓库路径，taskmd 不负责同步代码仓库资源。

配置不能把本机状态或固定配置目录放到任务库内部，也不能把任务库放进本机的 `local/` 状态目录。解析实际路径时再次检查这些关系，防止符号链接使本机状态进入共享任务库。工具无法判断任意目录是否被操作系统或第三方软件同步；`root` 仍应选在实际不参与同步的位置。

## 取消、归档和删除

`cancel` 是执行状态：把 `status` 设为 `canceled`，表示停止执行。取消父任务时，未完成的后代一并取消，已完成的后代保持 `done`。

`archive` 是独立的收纳标记：将任务及其子树设为 `archived: true`，默认从大纲和关系图中隐藏。归档前整棵子树都必须处于 `done` 或 `canceled`。归档不改变执行状态；`restore` 取消归档，也不会把任务重新变成待办。因此，取消和归档可以叠加，完成任务也可以直接归档。

详情中「任务属性」的状态下拉框提供取消、归档／取消归档和删除。选择取消后保存属性；选择归档／取消归档后点击对应确认按钮；选择删除后核对说明，再点击「确认永久删除」。删除是永久移除单个任务，必须同时满足：

- 已取消 **或** 已归档；仅 `done`、未归档还不能删除。
- 自己的 `blocked_by` 为空，且没有其他任务依赖它，包括已归档任务的依赖。
- 没有子任务；先移动或逐项删除子任务，不会自动删除整棵子树。

UI 会说明阻止原因，并要求再次确认永久删除；有未保存的正文或属性草稿时，先保存或放弃草稿。删除同时解除本机任务会话绑定，实际 DSH 会话和 Asset 文件保留。

```bash
taskmd status <id> canceled       # 或者将已结束的任务 archive
taskmd delete <id>                # 前置条件在 Store 层统一检查
taskmd delete <id> --if-version <version>
```

批量 `apply` 支持 `{ "op": "delete", "id": "...", "expectedVersion": "..." }`。删除在该批次的属性和状态变更之后检查；可以先显式解除依赖再删除。需要删除父子任务时，逐项列出删除操作并按子到父排序。删除使用相同的 `baseRevision`、事务日志和幂等回执；中断后会继续完成文件删除和本机绑定清理，外部修改冲突则停止恢复。结果中的 `versions` 只包含仍存在的变更任务，不包含被删除任务。

## 资源引用 UI

「资源引用」整体可以展开／收起，每个 Asset 的内容也可以独立展开／收起。内容在展开时读取，收起会取消未完成的读取；再次展开会重新读取实际文件。读取失败时可以单独重试。

「解除关联」经确认后只移除当前任务里的对应引用，不删除实际共享文件或仓库文件。写入包含任务版本和全库版本校验，冲突时不会覆盖他人的引用修改。引用列表变化后会清除旧预览，避免索引变化导致显示错配。

## 切换路径

`config set` 和 `config unset` 只改变路径选择，不自动搬迁或删除旧数据。更改 `root` 后，仓库映射、session 和回执从新目录读取；如需保留，应先停止相关服务并完整迁移旧的 `local/` 目录，再切换配置。任务库路径变化会改变本机子目录标识，需重新登记映射或有意识地迁移对应本地状态。

存在未恢复的提交时，命令会拒绝切换 `root`，先使用旧配置访问对应任务库完成恢复。已运行的服务在下一次操作时发现存储配置变化会返回 `config_changed`，需重启；不会继续默默写入旧目录。

同一用户的配置修改和 Store 操作通过固定配置锁协调，再取得任务库写锁，因此第一版会串行化同一用户的 taskmd Store 操作，避免切换本机根目录期间产生两套互不协调的写入者。锁只协调本机 taskmd，不协调另一台机器或外部编辑器。

## 增量元数据索引

`index.json` 是可删除、可重建的本地缓存，不同步、不作为事实来源，也不包含任务正文。普通文本输出的 `list`、`tree`、`ready` 使用索引：

1. 每次仍枚举全部任务文件，并读取文件状态。
2. 对比大小、纳秒修改时间/变更时间、inode、device 和 mode。
3. 未变化的文件复用元数据，变化的文件重新读取、计算哈希并解析。
4. 删除的文件移出索引；无效的新内容不能继续沿用旧任务。
5. 根据元数据重新计算图关系和 Ready。

缓存包含版本、任务库规范化路径、元数据、内容哈希、解析诊断与缓存校验和。格式错误、版本不匹配、损坏、超限或不可读时重建；缓存写入失败不影响查询。只有索引变化时才尝试原子持久化。外部编辑导致读取前后的文件状态不一致时有限次重试，持续变化的文件返回诊断而不缓存。

文件状态检查只是常规变更检测，不是严格内容验证。以下路径继续完整读取真实 Markdown，以保持既有正文、全库 revision 和提交校验语义：

- `--json` 查询、默认 `show` 和 `context`。
- `check` 和所有写操作、事务恢复。
- HTTP/DSH 的完整 state 接口。

`show <id> --raw`（未带 `--json`）只读取目标文件，正常情况下不扫描全库；如果存在待恢复提交，Store 会先按原有规则执行恢复。

没有常驻服务时，索引仍需要每次遍历目录；它主要减少不必要的文件内容读取和 YAML 解析，而不提供零扫描或跨机器事务。云同步期间可能短暂出现缺失引用，跨设备同时编辑同一任务需要处理云盘冲突，然后运行 `taskmd check`。

## 会话绑定

Session 是任务的外部执行关联（Execution Binding），只存在于本机 `sessions.json`，不同步、不进任务 Markdown，绑定与解绑不改任务的状态、依赖和父子结构。

一条绑定记录是 `{ taskId, provider, instanceId, sessionId, createdAt, lastOpenedAt? }`，Session 的唯一身份是 `(provider, instanceId, sessionId)`：

- `provider` 现在是字符串，本版本只写入 `dsh`。
- `instanceId` 是本机稳定标识，首次绑定时写入同目录的 `instance.json`（`{ instanceId }`，`randomUUID()`）。不使用主机名（会变、可能重复），也不用 DSH 会话 ID（那是被绑定的对象本身）。
- 一个任务可以关联多个 Session；同一 Session 只能关联一个任务，冲突时返回 `session_already_bound`（details 带 `taskId`、`existingTaskId`），由调用方确认后先解绑，不会静默改绑。
- 同一任务与同一 Session 重复绑定是幂等的，只刷新 `lastOpenedAt`。
- 没有 `instanceId` 的旧记录按本机实例补齐后照常读取，下一次写入时迁移成新格式。

在 DSH 的任务详情中，先选择工作目录、preset、模型与推理强度，并编辑初始化提示词，再点击「创建并发送首条消息」。界面按顺序创建空会话、绑定任务、应用模型、发送首条消息，最后打开会话。选择模型也会更新 DSH 的全局默认模型；保留「使用会话默认模型」则不调用模型设置接口。

手填工作目录优先于 Workspace 自动匹配；任务的 `repo` 改变后会清除原来的手动目标并重新匹配，新目录加载完成前不使用旧匹配结果。无效 preset 可清空后按默认值重试，模型目录读取失败可单独重试。

执行失败后，当前表单保留已创建的会话和已完成步骤，点击「继续执行」从失败处恢复。发送重试复用同一 `requestId` 与原提示词，交由 DSH 去重；发送开始后锁定模型与提示词，打开失败也不会再次发送。工作目录挂载失败时停止自动执行，保留打开会话的入口。重试进度仅保存在当前表单中，刷新或离开任务详情后需从已绑定会话列表打开既有会话。缺少发送能力的环境保留复制提示词后手动发送的方式。

DSH 插件注册 `taskmd.open`（“打开任务面板”）命令，不提供默认键位。用户在 DSH 快捷键设置中自行绑定；按键匹配、配置保存、冲突处理和触发分发均由宿主负责。

## 实现入口

- [配置解析与保存](src/core/config.ts)
- [Store、严格扫描及本地状态](src/core/store.ts)
- [增量元数据索引](src/core/metadata-index.ts)
- [CLI](src/cli.ts)
- [DSH Host](src/dsh/host.ts)

## 开发与验证

```bash
pnpm install
pnpm typecheck    # tsc --noEmit，覆盖 src/ 与 test/
pnpm test         # node --import tsx --test "test/**/*.test.ts"
pnpm build        # 产出 lib/，改动 src/ 后必须重跑才会影响 bin/taskmd.mjs
```

先跑 `pnpm typecheck && pnpm build && pnpm test` 再提交；全部通过才算完成验证。

`tsconfig.json` 的 `include` 同时包含 `src/` 和 `test/`，因此测试代码也受 `strict` 检查。
当前没有需要 `exclude` 隔离的既有类型错误；若将来 `src/dsh/` 或 `src/ui/` 依赖的可选
peer（`@deepseek-ai/*`、`react`）在本机缺失而无法类型检查，应单独拆一份 tsconfig 而不是
放宽主配置，并在本节记录原因。

### 测试约定

测试使用 `node:test`，入口在 `test/`，共享工具在 `test/helpers.ts`：

- `withSandbox()` 为每个用例创建临时 `HOME` 和临时 store，并设置 `TASKMD_STORE`，
  因此配置解析到 `<tmp>/home/.taskmd`，真实 `~/.taskmd` 与真实任务库不会被读写。
- `runCli()` 用 `node bin/taskmd.mjs` 起子进程（优先加载 `lib/cli.js`），显式传入
  `HOME`/`TASKMD_STORE`，并清掉继承来的 `DSH_SESSION_ID`，避免测试污染真实会话绑定。
- `Store` 在构造时解析配置，必须在 `withSandbox()` 内部创建；用后 `store.close()` 释放 watcher。
- 用例结束时整棵临时目录被删除，可重复运行、互不干扰。
- **注意**：`store.test.ts` 直接 import `src/`（经 tsx），但 `cli.test.ts` 走
  `node bin/taskmd.mjs`，它优先加载 `lib/cli.js`。改了 `src/` 又想用 CLI 用例覆盖新逻辑，
  必须先 `pnpm build`，否则 CLI 用例仍在测旧 bundle。

覆盖面包括 Store 的 create/apply 与幂等 `requestId`、图校验错误、版本冲突、会话绑定及损坏本地数据处理，以及 CLI 输出和错误码。Client bundle 测试验证 DSH Adapter 的创建、导航与快捷键注册；`session-launcher.test.ts` 使用真实 React 渲染器验证手动目录、repo 切换及异步竞态、preset 重试、模型应用和目录读取失败后的恢复。测试不连接真实 DSH Host，也不替代浏览器和操作系统快捷键实测。

配置与索引变更已通过 `pnpm typecheck` 与 `pnpm test`；运行时的真实任务库行为仍以实际使用为准。
