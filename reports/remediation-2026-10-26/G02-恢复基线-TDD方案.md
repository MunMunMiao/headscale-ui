# G02 个人身份恢复确认流程 Implementation Plan

> **执行约定：**后续获准实施时，使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 按任务执行。**本轮只设计 G02，没有改恢复实现，也没有运行下列拟新增回归。**不包含提交、推送、扩大容器权限或宿主网络变更。

**Goal:** 标签操作或明确读回后，管理员能够在同一恢复流程中重新读取并审阅有效设备基线，再显式确认；真正的身份/会话变化仍阻止旧授权派发。

**Architecture:** 把“原设备的稳定关联”“本次可重新审阅的标签/身份基线”和“请求是否可能已经派发”分层。复用现有只读读回与 scope/operation 代际；提交前失效可通过显式重读重建审阅，派发后只观察，绝不恢复已消费 Auth ID 或自动重试。

**Tech Stack:** `DevicesPage`、现有 session snapshot/tagLifecycle、Vitest browser、真实 Headscale/Tailscale lifecycle fixture。

**Spec:** [原始 G02](../usability-2026-10-26/问题汇总.md#g02)、[UX09 原始操作轨迹](../usability-2026-10-26/ux09/evidence/ui-operations-redacted.jsonl)。基线为 `4d21dd98`；按符号定位，不依赖被其他体验补丁移动的行号。

## 全局约束

- 不修改 `src/components/ui/**`，不删除或弱化 `sameNodeTagBaseline`、scope、generation、viewEpoch、错误服务器或可信来源保护。
- 不因“当前标签看起来相同”跳过 machine key、用户或服务器身份检查；缺少可信字段时 fail-closed。
- Auth ID 只保留在当前未提交表单，不能写入 tagLifecycle 的非秘密返回槽、日志、截图或一般持久草稿。
- 可能已派发、响应丢失或晚失败后，保持已消费 ID 清空，只允许只读观察；不增加恢复/重放队列。
- 只读读回不等同恢复成功，成功 toast 不等同目标用户/空标签/原设备读回匹配。
- 本方案不擅自增加 SSH/容器能力或重建之前已删除的实验环境。

## 1. 从旧行为开始：已知与未知

原始成员的序列是：

1. 在仍打开的标签编辑器移除 audit 标签并提交，保留 server。
2. 直接点 Restore personal identity；运行真实无 auth key 重认证。
3. 选择 Bob、确认公共服务器与可信请求。
4. 三次审批均显示 identity/tags/policy/server version changed，并清除来源确认。
5. 关闭、刷新、重开后才能完成。

源码支持的事实：

- `openPersonalRestore(node)` 保留传入节点作为 `restoreNode`。
- 标签保存已经尝试更新 `selectedTagsNode` 和 snapshot，并非完全没有读回。因此**不能仅凭报告断言某个 state 一定是根因**。
- `registerPendingNode` 重新读 fabric/identity，比较 scope、目标用户和 `nodeTagBaseline(original/current)`；不一致时拒绝派发，但没有把保留的 `restoreNode` 换成经过重新审阅的基线。
- `readPersonalIdentity` 目前只观察身份结果，没有提交前重建审阅基线的专门分支。
- `nodeTagBaseline` 包含 ID、machine key、用户 ID/用户名和完整 tags；用户展示投影不得污染这些原始字段。

最小错误模型：

```text
保留基线 A → 当前服务器读回 B → 审批阻止并取消来源确认
再勾来源确认 → 仍比较 A 与 B → 再次阻止
关闭/刷新/重开 → 新审阅以 B 开始 → 可以继续
```

这解释的是循环机制，不证明真实 B 的哪一个字段改变。实施前必须取得具体差异；不能为了测试“跑红”伪造不存在的后端响应。

## 2. 文件与责任

| 文件 | 计划责任 |
| --- | --- |
| `src/pages/DevicesPage.lifecycle.browser.test.tsx` | 按真实顺序补回归、显式重读恢复、fail-closed 与不重放对照 |
| `src/pages/DevicesPage.tsx` | 恢复意图原始关联、提交前重读/审阅分支、用户可理解的下一步 |
| `src/domain/tag-lifecycle.test.ts` | 仅补必要的基线/集合契约；不改安全比较来迎合 UI |
| `src/composables/tag-lifecycle-state.test.ts` | scope/generation/ABA 回归继续运行 |
| `src/i18n/descriptors.ts` 和语言目录 | 明确“重新读取并重新核对”与“只读观察”的区别 |
| `e2e/tag-lifecycle.browser.test.tsx`、`scripts/harness/tag-lifecycle.ts` | 用真实重认证验证 UI 流程及不重发 |

现有可复用函数：`setup(patch)`、`fixtureNode(backend)`、`openTags()`、`openRestore(ctx)`、`AUTH_ID`、`ctx.writes()`、`holdReads()`、`failRead()`、`loseWriteResponse()`。计划内的 `AUTH_ID` 是既有合成测试常量，不是实际凭据。

## 3. Task 1：先定位真实序列，再建立 RED

- [ ] 在真实隔离 fixture 中重放“全量替换标签→不关闭编辑器直接恢复→真实非 auth key 请求”的精确时序。
- [ ] 只记录非秘密基线差异：nodeId、machine key 的一致/不一致标志、userId/name、tags、scope generation/versionFresh、operation/viewEpoch。不可记录完整 Auth ID、私钥或认证配置。
- [ ] 对每次最终 pre-read 标明哪些字段改变、属于本次已确认写入还是之后的真实变化；区分 API 响应与 GET 读回，不从 toast 反推。
- [ ] 先在现有 browser fixture 中重放无额外后端变化的复合流程。如果通过，记录它只是控制组；不能谎称拿到了原始故障 RED。
- [ ] 用真实差异缩减失败 fixture，再进入 Task 2。若真实重放表明保护本身正确而仅指引错误，保留保护，仍以“没有有效重读/重新审阅路径”作为待修行为，不强行归因陈旧 state。

## 4. Task 2：显式重读必须能解除可重审的提交前阻断

下面用例验证同物理设备的标签基线变化，不宣称它已经完整重现所有原始后端差异。使用现有组件，不 mock 恢复向导，不改 fake 后端让其替 UI 决策。

- [ ] 在 `DevicesPage.lifecycle.browser.test.tsx` 加入：

```tsx
test("explicit recovery reread renews a changed tag baseline only after new confirmations", async () => {
  const ctx = await setup((backend) => {
    fixtureNode(backend).tags = ["tag:prod", "tag:extra"];
  });
  await openRestore(ctx);
  await page.getByTestId("restore-source-confirm").click();

  fixtureNode(ctx.backend).tags = ["tag:prod"];
  await page.getByTestId("restore-personal-confirm").click();
  await expect.element(page.getByTestId("restore-safety-error")).toBeVisible();
  expect(ctx.writes()).toEqual([]);
  await expect.element(page.getByTestId("restore-auth-id"))
    .toHaveValue(`https://public.example/register/${AUTH_ID}`);

  await page.getByTestId("restore-readonly-check").click();
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  expect(ctx.writes()).toEqual([]);
  for (const id of [
    "restore-server-confirm",
    "restore-backup-confirm",
    "restore-source-confirm",
  ]) {
    await expect.element(page.getByTestId(id)).not.toBeChecked();
    await page.getByTestId(id).click();
  }
  await page.getByTestId("restore-personal-confirm").click();
  await expect.poll(() => ctx.writes().length).toBe(1);
  expect(ctx.writes()[0]).toEqual({
    method: "POST",
    path: "/api/v1/auth/register",
    body: { user: "bob", authId: AUTH_ID },
  });
  await expect.element(page.getByTestId("restore-auth-id")).toHaveValue("");
  expect(fixtureNode(ctx.backend).tags).toEqual([]);
  expect(fixtureNode(ctx.backend).user?.id).toBe("2");
});
```

- [ ] 执行该用例并保存真正业务断言的失败输出：

```bash
bun run --bun vitest run --project browser src/pages/DevicesPage.lifecycle.browser.test.tsx -t "explicit recovery reread renews a changed tag baseline"
```

**期望 RED：**现版只观察，不重建提交前审阅基线，也未按新审阅撤销全部确认；再次批准仍无预期的一次 authRegister。若失败来自选择器或 fake 输入错误，先修测试，不开始修改业务。

## 5. Task 3：最小 GREEN，提交前重审与提交后观察分离

新增一个局部状态，明确本次恢复请求是否已经进入提交阶段；在 `resetAuthChecks()` 清零，在消费 Auth ID/调用 mutation 前置为已提交。此状态不能用于重放，只用于限制只读按钮的语义：

```ts
const restoreSubmissionStarted = useRef(false);
```

- [ ] 提交前的显式读回继续使用 `authOperation`、`captureSession`、`viewEpoch` 和 `tagLifecycle`；过期结果不能更新新意图。
- [ ] 读回不成功时保留尚未消费的输入，显示失败，任何确认都不能导致写入。
- [ ] 同物理设备且仍适合标签身份恢复时，把最新原始节点放入新的待审基线；显示当前标签/归属，并撤销服务器、备用通道和来源三个确认。
- [ ] 已经是目标个人身份时，只报告读回匹配，不再派发 AuthRegister；已经转给不同个人或无法唯一关联时停止并解释，不猜归属。
- [ ] `restoreSubmissionStarted.current` 为真后，只执行现有 `observePersonalIdentity`，不重建可提交状态，不恢复已消费 ID。

核心分支的接口约束如下，实施者应把它置于现有成功读回且 scope 仍有效的分支，而不是删除 `registerPendingNode` 的比较：

```ts
if (restoreSubmissionStarted.current) {
  observePersonalIdentity(original, target);
  return;
}
if (!original.machineKey) {
  setAuthSafetyError(copy.restoreBaselineUnavailable);
  setAuthSourceConfirmed(false);
  setAuthCheckScope(null);
  return;
}
const matches = session.snapshot.getSnapshot().snapshot.nodes.filter(
  (node) => node.machineKey === original.machineKey,
);
const current = matches.length === 1 ? matches[0] : undefined;
if (!current) {
  setAuthResult("observation-conflict");
  setAuthSourceConfirmed(false);
  setAuthCheckScope(null);
  return;
}
if (current.tags.length === 0) {
  observePersonalIdentity(original, target);
  return;
}
if (
  current.user?.id !== original.user?.id ||
  current.user?.name !== original.user?.name
) {
  setAuthSafetyError(copy.restoreBaselineUnavailable);
  setAuthSourceConfirmed(false);
  setAuthCheckScope(null);
  return;
}
setRestoreNode(current);
setAuthResult(null);
setAuthSourceConfirmed(false);
setAuthServerConfirmed(false);
setAuthBackupConfirmed(false);
setAuthCheckScope(null);
setAuthSafetyError(copy.restoreBaselineReread);
```

`original` 与 `target` 在异步开始前分别捕获当前 `restoreNode` 和 `authTargetUser`。新的“可再次提交的基线重建”分支要求原始 machine key 存在、在当前服务器唯一匹配，不能只按旧 nodeId 查找或用用户名/邮箱猜关联；因此不把“重认证总保留 ID”写成保证。缺失关键机器关联时只读并引导关闭、通过可信通道重新开始，不扩大原有 ID 回退的授权能力。已派发后的原有观察分支仍复用既有匹配规则，本任务不重构它。`restoreBaselineUnavailable` 明确说明无法唯一、安全地重建该次基线，未发送批准；所有新增文案均进描述符及语言目录。新的用户归属不一致时默认停止，不能靠重读静默接受；若 Task 1 证明只是合法的后端表现差异，应先加入契约负例再调整，不能猜等价。

新文案 `restoreBaselineReread` 明确为“已重新读取当前设备基线。请核对当前用户和完整标签，并重新确认服务器、备用管理通道和本次请求来源。尚未发送批准请求。” 不把它显示成恢复成功。现有只读按钮如果改变了提交前职责，需用上下文说明区分“重读以重新审阅”和“提交后只观察”。

- [ ] 重新运行 Task 2，确认仅一次 AuthRegister、目标用户与空标签匹配；未提交前的重读只产生 GET。

## 6. Task 4：安全反例必须仍然通过

在同一 test file 复用现有 helper，覆盖以下具体结果：

| 场景 | 必须保持的结果 |
| --- | --- |
| machine key 或设备关联改变 | 重读不能把另一设备收为原设备；0 写入 |
| 目标用户被改名/移除 | 不回退到首用户；0 写入 |
| 版本 ABA、退出/重新解锁、切服 | 旧确认失效；旧读回不更新新意图；0 写入 |
| 重读等待时关闭/重开向导 | 晚结果不能复活旧状态 |
| identity/fabric GET 失败 | 输入未消费，不派发批准，不伪称恢复成功 |
| 批准响应丢失或晚失败 | ID 仍清空；只读按钮不重新批准 |
| 已确认批准但读回仍有标签/节点缺失 | 交付与观察分离，不显示身份已匹配 |
| 同物理设备已被另一操作转给不同个人 | 不自动接受新归属，不向旧目标重复注册 |
| 从菜单、标签编辑器、窄屏入口进入 | 复用同一安全流程，不能只修其中一个入口 |

现有命名用例不得弱化，包括：`recovery identity changes invalidate source approval`、`recovery source approval is revoked by version ABA and re-unlock`、`reopening personal recovery after an uncertain write`、`a fresh version change during recovery pre-read`。

```bash
bun run --bun vitest run --project browser src/pages/DevicesPage.lifecycle.browser.test.tsx
```

```bash
bun run --bun vitest run --project unit src/domain/tag-lifecycle.test.ts src/composables/tag-lifecycle-state.test.ts
```

## 7. Task 5：真实生命周期验证与验收

- [ ] 用现有独立真实 fixture 完成“替换标签→同编辑器恢复→真实无 auth key 请求→发生的保护→显式重读→重新审阅→一次批准→读回”。
- [ ] 记录只读 GET 与一次批准的派发次数，不能因为 Auth ID 已消费而自动申请/重建请求。
- [ ] 同设备/目标用户/空标签及新的 TCP 连通性同时成立，才标记身份观察通过；退出和未知结果仍按原保护处理。
- [ ] 再次测试真实外部身份变化的拒绝对照；只放行已重新审阅的相同物理设备，不改 `nodeTagBaseline` 来隐藏差异。
- [ ] 实施结束运行完整项目检查，长任务后台等待真实退出。

```bash
bun run verify
```

**验收：**原始序列的具体差异有非秘密证据；RED 是真实流程断言失败；显式重读可恢复可重审状态；真实变化仍 fail-closed；不存在旧 Auth ID 自动恢复、重复批准或跨会话结果回填。

**未解决的知识边界：**原报告没有完整逐次 API/HAR，所以本方案不能预先宣称唯一根因是陈旧 React state。TDD 的第一步就是让真实差异和受控回归决定最小补丁，而不是为预设实现拼一个红测试。

**自检：**方案覆盖了数据形态、控制流、失败恢复、并发/退出边界和真实客户端读回；没有把身份保护误当应删除的障碍，没有伪造已经执行的 RED/GREEN。