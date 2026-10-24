#!/bin/sh
# 往当前 taskmd store 写入一组示例任务（harless 仓库自身的待办）。
# 用法：sh apps/taskmd/examples/seed-tasks.sh
# 幂等：requestId 固定，重复执行返回上次结果；想重新播种请改 requestId。
set -e
command -v taskmd >/dev/null || { echo "taskmd 不在 PATH 中" >&2; exit 1; }

REV=$(taskmd list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).revision))')

node -e '
const rev = process.argv[1];
const t = (title, extra = {}) => ({ op: "create", task: { title, ...extra } });
const k = (key) => ({ key });
const plan = {
  requestId: "harless-taskmd-seed-v1",
  baseRevision: rev,
  operations: [
    t("taskmd：DSH 插件落地", { body: "# 目标\n把 apps/taskmd 从源码变成 DSH 里可用的面板。\n\n## 完成标准\n- `pnpm build` 产出 lib/index.js 与 lib/client.js\n- profile 里能看到任务图主面板与会话侧栏页签\n" }),
    t("生成 lib/ 构建产物", { parent: k("p1"), body: "# 内容\n`node scripts/build.mjs` 产出两个 bundle。\n\n## 注意\n- Host bundle external `@deepseek-ai/*`\n- Client bundle 必须 external react 与 dsh-client-store\n" }),
    t("装进 profile 并验证面板注册", { parent: k("p1"), blocked_by: [k("c1")], body: "# 内容\n在 profile 里 link 该包，重启后确认面板与侧栏页签出现。\n\n## 验收\n宿主与插件共用同一份 React 实例，无重复运行时告警。\n" }),
    t("验证任务与会话双向跳转", { parent: k("p1"), blocked_by: [k("c2")], body: "# 内容\n`taskmd start` 在 `DSH_SESSION_ID` 存在时写绑定，前端据 bindings 渲染跳转。\n\n## 验收\n从任务节点能跳到会话，从会话侧栏能跳回任务。\n" }),

    t("arch 文档：补齐 taskmd 相关实体", { body: "# 目标\ndocs/arch/ 目前只有 rules/，需要按 harless-doc 补齐 Module / Contract / Behavior。\n\n## 范围\n只补 taskmd 与 memory 两条链路，不追求全量。\n" }),
    t("写 Module 与 Contract 文档", { parent: k("p2"), repo: "harless", body: "# 内容\n为 core/store、CLI、HTTP server、DSH Host 各写一份 Module 与 Contract。\n\n## 要求\nsource 字段指向真实代码路径，接口签名与实现一致。\n" }),
    t("写 Behavior 页面（版本冲突与事务恢复）", { parent: k("p2"), repo: "harless", body: "# 内容\n把 README 里散落的规则收敛成可检索的 Behavior。\n\n## 覆盖\n- revision / version 两级版本语义\n- pending.json 事务恢复与冲突拒绝\n- Ready 判定条件\n" }),
    t("跑 graph.py 校验文档图", { parent: k("p2"), blocked_by: [k("c4"), k("c5")], body: "# 内容\n`skills/harless-doc/scripts/graph.py` 生成依赖图并校验引用完整性。\n" }),

    t("memory：备份保留与恢复链路", { body: "# 目标\nmemory 模块已有 7 天备份，但缺少可操作的恢复入口。\n" }),
    t("前端展示 .history 备份列表", { parent: k("p3"), repo: "harless", body: "# 内容\nmemory 页增加备份列表，可预览与一键回填。\n\n## 约束\n不新增删除 API，沿用写空文件即删除的约定。\n" }),
    t("补 memory 备份与清理的测试", { parent: k("p3"), repo: "harless", body: "# 内容\n覆盖：写入留备份、7 天后过期清理、空内容不备份。\n" }),

    t("taskmd serve：独立 Web 体验打磨", { body: "# 目标\n不装 DSH 时，`taskmd serve` 的内联页面要能完成日常操作。\n" }),
    t("SSE 变更通知在前端生效", { parent: k("p4"), body: "# 内容\n/api/events 已有，但页面刷新策略需要验证是否会打断编辑中的草稿。\n" }),
    t("CLI 帮助文本补 Agent 使用示例", { parent: k("p4"), body: "# 内容\n`apply` 已有示例；`context`、`edit` 需要补一段可直接复制的示例。\n" }),
  ],
};
// 父任务先声明 key，子任务才能引用；这里按出现顺序补 key。
const keys = { 0: "p1", 4: "p2", 8: "p3", 11: "p4", 1: "c1", 2: "c2", 3: "c3", 5: "c4", 6: "c5", 7: "c6" };
for (const [index, key] of Object.entries(keys)) plan.operations[index].key = key;
process.stdout.write(JSON.stringify(plan));
' "$REV" | taskmd apply -f -

echo
echo "写入完成。查看：taskmd tree && taskmd ready"
