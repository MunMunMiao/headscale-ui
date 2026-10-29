# E2E 门控修正：G01 preflight 与 mutation 后 refresh

日期：2026-10-26。

## 结论与范围

这是 **test-injection 时序适配，不是产品 bug 修复**。G01 新增的 fresh identity preflight 正确阻止了目录读取失败后的 POST；旧 E2E 把原本计划用于写后 refresh 的无效响应提前注入了 preflight。

本轮仅修改 `e2e/headscale-ui.browser.test.tsx` 内既有 `does not replay a successful mutation when its following refresh fails`：7 行新增、3 行删除，测试数量不变。另新增本报告。没有修改生产 source、其他测试、fixtures、配置、依赖、timeout 或 threshold；没有绕过/关闭 preflight、增加 sleep、派生代理、提交/推送、切分支或启动 devserver。

## 1. 修改前证据

先完整读取并核实既有日志 `/tmp/headscale-g01-g02-final-e2e-20261026.log`，没有为获取相同结果重复运行完整 E2E。

- 原命令：`bun run e2e`，实际退出 1。
- 主 lane：`1 failed | 88 passed (89)`；目标所在文件 `1 failed | 87 passed (88)`。
- 失败位置：原 `e2e/headscale-ui.browser.test.tsx:3679:49`。
- 失败断言：`operationCount("user.create")` 期望 `createsBefore + 1`，实际为 0。
- 网络明细显示被 gate 捕获的是 `GET /api/v1/user`，之后没有创建 POST。实际流程已停在 G01 fresh identity 读取失败的 fail-closed 分支。
- 主 runner 因该失败退出，后续 lifecycle/contract 等 lane 尚未运行。不能把原输出写成完整 E2E 通过。

初次只读校验 `.superpowers/sdd/G01-身份歧义-TDD方案/final-frozen-state.json` 的 394 项时，当前工作区与该清单的 SHA256 差异为 0。

## 2. 已核对的真实调用关系

- `src/pages/MembersPage.tsx:700+`：`createMember` 先 `refreshSegments(["identity"])`；读取失败返回，只有成功且上下文仍有效才执行 `mutate("create-member", createUser)`。
- `src/composables/useMutation.ts:144+`：写入 reply 成功后再刷新 `ALL_SEGMENTS`；refresh 失败与已确认的写入结果分开，不重放写入。
- `scripts/harness/session-network.ts:148–163`：无故障 POST gate 正常转发上游，并在上游响应 body 已完整读取之后才设置 `captured: true`，随后暂停向客户端交付响应。仅观察 operation count 只能证明请求进入代理，不能替代此完成门控。
- `vitest.e2e.config.ts:65–78`：`interceptHeadscaleRequest` 在同一次 browser command 中释放旧 gate，再安装新 gate；没有额外 browser round trip。
- 目标测试现成的 `expectHeadscaleGate()` 同时要求 `hits: 1`、`upstreamRequests: 1`、`captured: true`。复用它，不增加 helper 或等待阈值。

## 3. 最小修正与保留断言

新的顺序为：

1. 提交前只安装 `POST ^/api/v1/user$` 的正常响应 gate；所有 G01 preflight GET 都真实通过。
2. 点击创建，等待 POST 已收到真实上游响应，再断言创建计数恰为 `createsBefore + 1`。
3. 在同一个 `interceptHeadscaleRequest("GET", ...)` 命令中释放已捕获的 POST reply 并安装下一次 GET 的 `{ users: "invalid-array" }` 故障。没有先单独释放 POST、再跨一个 browser command 安装 GET 所产生的额外竞争窗口。
4. 等待后续 refresh GET 确实捕获，释放无效响应，完成原有断言。

全部保留的原断言包括：写入至多一次、`refreshErrors.identity` 存在、创建对话框关闭、直接读取真实后端确认用户已持久化、手动刷新恢复用户列表、创建计数仍不增加、refresh 错误清除。仅新增了 POST gate 完成时的计数断言。

没有新增重复的 preflight 测试。既有真实 G01 用例位于 `e2e/tag-lifecycle.browser.test.tsx:228`，验证身份歧义零 POST 与修正输入后唯一创建；它不是 dedicated 读取失败对照。本轮另外定向重跑既有组件测试的三种 identity 读取失败零 POST 与重复提交锁，不能把这 4 项组件验证称为真实 Headscale E2E。原始失败日志也保留了真实无效 preflight 响应时零 POST 的观测证据。

## 4. 如何仅运行主 lane

`package.json` 的 `e2e` 还会续跑其他脚本；`scripts/run-e2e.ts:247+` 虽会向第一条 Vitest 传递过滤参数，但成功后无条件运行 lifecycle/contract lane，没有单主 lane 开关。

为避免修改任何 runner/config/fixture，本轮通过 `bun run --bun --cwd /Users/munmunmiao/Documents/web/headscale-ui -` 的 stdin 入口，在内存中复用原 runner 从初始化到第一条 Vitest 的原始代码及最外层原有 catch/finally/cleanup；截去后续 lane。只调整内存模块的导入地址、root 和启动参数，使实际测试子命令使用 `bun run --bun vitest`。没有将派生 runner 写入磁盘，也没有改原 runner 文件。

两次真实 E2E 共用以下 stdin 内容；`TEST_PATTERN` 分别取后面的目标/相邻表达式，stdout/stderr 重定向到表中日志。原 fixture 的端口预留、seed、snapshot、重置、网络就绪等待、信号处理及 owned 清理保持原样。

```js
import assert from "node:assert/strict";
import { resolve } from "node:path";
const root = "/Users/munmunmiao/Documents/web/headscale-ui";
let source = await Bun.file(resolve(root, "scripts/run-e2e.ts")).text();
const end = source.indexOf("  // The lifecycle lane owns separate short-reclaim clients");
const cleanup = source.lastIndexOf("} catch (error) {");
assert.ok(end > 0 && cleanup > end, "Existing main-lane setup and cleanup boundaries must remain intact");
source = source.slice(0, end) + source.slice(cleanup);
source = source.replace(/from "(\.{1,2}\/[^\"]+)"/g, (_, path) => `from ${JSON.stringify(resolve(root, "scripts", path))}`);
source = source.replace('const root = fileURLToPath(new URL("..", import.meta.url));', `const root = ${JSON.stringify(root)};`);
const args = ["e2e/headscale-ui.browser.test.tsx", "--browser.screenshotFailures=false", "--reporter=verbose", "-t", process.env.TEST_PATTERN];
assert.ok(args.at(-1), "A focused test pattern is required");
assert.ok(source.includes('      "bun",\n      vitest,\n'));
source = source.replace('      "bun",\n      vitest,\n', '      "bun",\n      "run",\n      "--bun",\n      "vitest",\n');
const argv = '...process.argv.slice(2).filter((arg) => arg !== "--"),';
assert.ok(source.includes(argv));
source = source.replace(argv, `...${JSON.stringify(args)},`);
console.info("[scoped-e2e] Reuse original main-lane setup/cleanup in memory; no lifecycle or contract continuation");
console.info("[scoped-e2e] bun run --bun vitest run --config vitest.e2e.config.ts", ...args);
const js = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(source);
await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
```

目标表达式：

```text
^does not replay a successful mutation when its following refresh fails$
```

相邻表达式：

```text
^(recovers a failed snapshot refresh without losing the current data|keeps the newest identity fabric and policy after older responses are released|retains current data and online health when a refresh response violates its contract|reports a committed write whose reply is unusable as unconfirmed and shows the saved result without replaying it|accepts a policy save without replacing edits made while its response was held|preserves a failed mutation and succeeds when retried)$
```

## 5. 实际命令与结果

下列测试按目标 GREEN、相邻真实回归、G01 组件对照的顺序完成。表中时长为 Vitest 输出，不包含 Docker fixture 初始化和最终清理耗时。

| 检查 | 实际退出 | 测试数/结果 | 日志 |
| --- | --- | --- | --- |
| 目标真实 E2E，15:52:05 开始 | 0 | `1 passed | 87 skipped (88)`；6.95s | `/tmp/headscale-g01-e2e-gate-target-green-01-20261026.log` |
| 相邻真实请求/刷新回归，15:53:44 开始 | 0 | `6 passed | 82 skipped (88)`；39.83s | `/tmp/headscale-g01-e2e-gate-adjacent-20261026.log` |
| G01 failed-read 与重复提交组件对照，15:54:56 开始 | 0 | `4 passed | 128 skipped (132)`；5.67s | `/tmp/headscale-g01-e2e-gate-preflight-regression-20261026.log` |
| 目标文件 oxlint | 0 | 无 lint 错误 | `/tmp/headscale-g01-e2e-gate-static-20261026.log` |
| 目标文件格式检查 | 0 | `1 file is formatted.` | 同上 |
| 目标文件 diff 空白检查 | 0 | 无输出 | 同上 |

两条真实 E2E 的实际子命令分别为：

```bash
bun run --bun vitest run --config vitest.e2e.config.ts e2e/headscale-ui.browser.test.tsx --browser.screenshotFailures=false --reporter=verbose -t '^does not replay a successful mutation when its following refresh fails$'
```

```bash
bun run --bun vitest run --config vitest.e2e.config.ts e2e/headscale-ui.browser.test.tsx --browser.screenshotFailures=false --reporter=verbose -t '^(recovers a failed snapshot refresh without losing the current data|keeps the newest identity fabric and policy after older responses are released|retains current data and online health when a refresh response violates its contract|reports a committed write whose reply is unusable as unconfirmed and shows the saved result without replaying it|accepts a policy save without replacing edits made while its response was held|preserves a failed mutation and succeeds when retried)$'
```

其他实际命令：

```bash
bun run --bun --cwd /Users/munmunmiao/Documents/web/headscale-ui vitest run --project browser src/pages/MembersPage.fixes.browser.test.tsx --browser.screenshotFailures=false --reporter=verbose -t 'G01 a failed identity read|G01 repeated submits remain locked'
```

```bash
bun run --bun --cwd /Users/munmunmiao/Documents/web/headscale-ui oxlint e2e/headscale-ui.browser.test.tsx
```

```bash
bun fmt --check /Users/munmunmiao/Documents/web/headscale-ui/e2e/headscale-ui.browser.test.tsx
```

```bash
git -C /Users/munmunmiao/Documents/web/headscale-ui diff --check -- e2e/headscale-ui.browser.test.tsx
```

合计为 **7 项真实 Headscale E2E + 4 项组件测试通过**，不是全仓/完整 E2E 通过。未运行 coverage、build、完整 e2e，留给主协调统一执行。

一次入口探测 `bun --cwd ... run --bun -` 实际只打印 Bun CLI help 并返回 0，没有启动测试；日志 `/tmp/headscale-g01-e2e-gate-target-green-20261026.log` 保留，明确不计作 GREEN。随后改用 Bun 正确支持的 `bun run --bun --cwd ... -` 得到表中的真实测试结果。`/dev/stdin` 入口探测也未启动测试，不计入测试数。

## 6. 隐私、已有告警与清理

- 原始日志及本轮 5 个日志均为 `0600`；创建日志前使用 `umask 077`。没有输出实际 API key、Authorization 或 AuthID，也没有访问 playground 凭据。
- 真实 API key 仅由原 runner 从新建 fixture 捕获并经进程环境传给测试。`--browser.screenshotFailures=false` 仅防止失败截图泄露，不修改配置文件或任何超时/阈值。
- 两次真实运行仍有既有 Vite native loader 对 `session-network.ts` 无扩展名 import 的未来兼容性提示。相邻的旧响应释放用例还出现既有 `Bun.serve()` 10 秒 idle timeout 与 `/api/v1/policy` proxy `socket hang up` 日志；原始完整日志也有同类输出。6 项断言及进程均通过，但不能描述为“无告警”。未为消除这些范围外输出改动 timeout 或生产实现。
- 本轮仅操作原 runner 创建的 `headscale-ui-e2e-22826` 与 `headscale-ui-e2e-23113`。原 finally 已清理其 Compose 容器、卷、网络及快照；随后按各自准确 `com.docker.compose.project` label 只读列举容器/卷/网络，6 次查询均退出 0 且残留数为 0，两处日志记录的快照路径均不存在。

## 7. 最终 source/test 冻结与 SHA256

原冻结清单未改写：

```text
/Users/munmunmiao/Documents/web/headscale-ui/.superpowers/sdd/G01-身份歧义-TDD方案/final-frozen-state.json
SHA256 93f211fa8ccde9cf5e7351e189a55494d1df9f95f3374e425613148f9502e578
```

最终重新逐项比较原冻结清单全部 394 项，只有获准的 `e2e/headscale-ui.browser.test.tsx` 变化；其余 393 项逐字节哈希不变，已有 G01/G02 与旧补丁均保留。报告不在该旧清单内。

聚合算法为：对原清单相应路径升序排序，拼接每行 `path + "\t" + sha256 + "\n"` 的 UTF-8 字节，再做 SHA256。生产集合为 `src/` 中排除 `.test.` 文件及 `/test/`、`/test-utils/`、`/__fixtures__/`、`/__tests__/`、`/__mocks__/` 目录的 153 项；同时核对全量 `src/` 的 308 项，避免仅靠分类遗漏改动。

| 范围/文件 | before SHA256 | after SHA256 |
| --- | --- | --- |
| 生产 source，153 项聚合 | `109bde8628ac6d00d5ac17147483cb8fc9d1b32e4d02f045800f67c60705d347` | `109bde8628ac6d00d5ac17147483cb8fc9d1b32e4d02f045800f67c60705d347` |
| 全量 `src/`，308 项聚合 | `c2ad7bf2b01ad5dea67066f5639c95036477252ac92288be3a1c916a01044114` | `c2ad7bf2b01ad5dea67066f5639c95036477252ac92288be3a1c916a01044114` |
| `src/pages/MembersPage.tsx` | `881d9fb022e15a18b6d37a0ba0b368d3165e1800916bc681ca42f87e6b5b1cf9` | `881d9fb022e15a18b6d37a0ba0b368d3165e1800916bc681ca42f87e6b5b1cf9` |
| `src/composables/useMutation.ts` | `75db0080baa41bc8599fc4f4175fd618474a9f3971ccef0d326dbb561226a067` | `75db0080baa41bc8599fc4f4175fd618474a9f3971ccef0d326dbb561226a067` |
| 既有 G01/G02 `e2e/tag-lifecycle.browser.test.tsx` | `fa4918b46252d7a4a7cd205eb8413ccc99e8ec125d19aa268c1c7f8224670dca` | `fa4918b46252d7a4a7cd205eb8413ccc99e8ec125d19aa268c1c7f8224670dca` |
| 本次目标 `e2e/headscale-ui.browser.test.tsx` | `9fd8d62dbf6dab5f36369174aa7317792960d9734234ff34ff79751c9a4c59a1` | `ac54067a756e6d0d1a4e2bbcc4fb7a83e2c73d5f02d0a0ed94fc255087782754` |

测试补丁到上述 SHA256 后不再修改。生产 source 保持原冻结状态。未提交、未推送；主协调可据此终态继续完整 E2E。
