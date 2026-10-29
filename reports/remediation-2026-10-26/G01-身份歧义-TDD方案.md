# G01 身份歧义防护 Implementation Plan

> **执行约定：**后续获准实施时，使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 按任务执行。以下复选项均为计划，**本轮没有实现 G01，也没有运行这些拟新增的 RED 用例**。技能中的提交建议不构成授权；本方案不包含提交、推送或生产写入。

**Goal:** 阻止本 UI 的新建用户操作把原本可唯一解析的策略 principal 变为歧义或改指其他用户，保护已经工作的访问规则。

**Architecture:** 复用 `domain/principal.ts` 的 Headscale 0.29.4 身份解析语义，比较新建前后的目录解析影响。界面即时提示只作辅助；提交前重新读取当前 identity 段并校验，再交给现有 mutation 通道至多派发一次。保留服务端契约及既有目录，不自动删除用户或重写策略。

**Tech Stack:** React、TanStack Form、项目 session/snapshot/mutation、Vitest unit/browser、现有真实 Headscale/Tailscale E2E。

**Spec:** [原始 G01](../usability-2026-10-26/问题汇总.md#g01)、[两环境复核 V01](../usability-2026-10-26/问题复核.md)。设计基于提交 `4d21dd98`；本轮其他体验补丁可能移动行号，实施时按符号定位。

## 全局约束

- `src/components/ui/**` 保持上游原样。
- 不修改 Headscale API schema，不把 UI 防护宣称为服务端全局邮箱唯一约束。
- 不将所有邮箱转小写；沿用当前身份解析的 trim、尾部 `@` 和 provider 优先级语义，并用真实 0.29.4 契约检验。
- 不自动把既有邮箱引用改成用户名，不修改已经歧义的历史目录；无关新用户及已有目录浏览必须继续可用。
- 只读失败、退出、切服、视图失效时 fail-closed；不得重放创建请求。
- 所有新增文案按项目现有描述符与全部语言目录集中更新；不让 message ID 裸露在 UI。
- 回归测试必须先对现版出现业务断言失败；编译失败、缺少导出、定位拼错不算 RED。

## 1. 已确认事实与真实调用链

数据形态示例：

```json
{
  "users": [
    {"id":"1","name":"alice","email":"alice@example.test"}
  ],
  "policy": {
    "groups":{"group:ops":["alice@example.test"]},
    "acls":[{"action":"accept","src":["group:ops"],"dst":["100.64.0.2:8081"]}]
  }
}
```

再创建 `name=alice-copy,email=alice@example.test`，会令已用邮箱引用无法唯一解析；两套真实实验均出现连接失败，删除新用户后恢复，策略原文不变。

当前路径：

1. `MembersPage.tsx` 的表单验证用户名形状/重名和邮箱形状。
2. `openMemberDialog()` 发起一次不等待的刷新，不能替代提交前读回。
3. `createMember()` trim 字段后直接 `mutate("create-member", {endpoint:"createUser", input})`。
4. `api/requests.ts:createUser` 只映射 POST；其注释明确校验应发生在 command 构建前。
5. `policyPrincipalForUser`、`userMatchesPolicyValue` 已能识别歧义和 provider 优先级，但创建入口没有使用它们保护已有引用。

推荐行为不是“所有邮箱全局唯一”，而是**本 UI 不制造新的身份解析破坏**。已有 provider 优先权、同名替换以及已歧义目录均按真实契约处理，不另造简化解析器。

## 2. 文件与接口

| 文件 | 作用 |
| --- | --- |
| `src/domain/principal.ts` | 新增纯函数 `userCreationPrincipalConflict`，复用既有解析函数 |
| `src/domain/principal.test.ts` | 手工推导的目录解析影响用例；沿用 `makeUser` |
| `src/pages/MembersPage.tsx` | 表单提示、提交前新鲜目录校验、关闭/切服保护 |
| `src/pages/MembersPage.fixes.browser.test.tsx` | 真实组件与现有 stateful transport 的主要 RED/GREEN |
| `src/i18n/descriptors.ts`、`src/i18n/locales/*/messages.{po,ts}` | 冲突和读回失败文案 |
| `e2e/headscale-ui.browser.test.tsx`、现有真实 fixture | 最终真实 UI 不派发危险创建、既有流量保持的限定验证 |

拟新增接口：

```ts
export interface UserCreationPrincipalConflict {
  field: "name" | "email";
  principal: string;
}

export function userCreationPrincipalConflict(
  candidate: Pick<HeadscaleUser, "name" | "email">,
  users: readonly HeadscaleUser[],
): UserCreationPrincipalConflict | null;
```

输入是本次规范化候选和最新目录，不接收密码、API key 或整份 session。输出仅用于阻止创建和指出冲突字段，不是改写策略的计划。

## 3. Task 1：先让真实创建入口的回归变红

**Files:** 修改 `src/pages/MembersPage.fixes.browser.test.tsx`，复用现有 `setup()`、`backend`、`calls` 和测试 ID，不 mock `MembersPage`。

- [ ] 添加下面用例；fixture 必须继续像真实 0.29.4 一样接受重复邮箱，不能让 fake 后端替 UI 拒绝。

```tsx
test("rejects a new member that makes an existing policy principal ambiguous", async () => {
  const ctx = await setup();
  await page.getByTestId("open-create-member").click();
  await page.getByTestId("member-name").fill("alice-copy");
  await page.getByTestId("member-email").fill("alice@example.com");
  await page.getByTestId("create-member").click();

  await expect
    .element(page.getByTestId("member-email"))
    .toHaveAttribute("aria-invalid", "true");
  await expect.element(page.getByTestId("member-email-error")).toBeVisible();
  expect(ctx.backend.users.map((user) => user.id)).toEqual(["1", "2", "0"]);
  expect(
    ctx.calls.filter(
      (call) => call.method === "POST" && call.path === "/api/v1/user",
    ),
  ).toEqual([]);
});
```

- [ ] 单独运行，记录实际失败输出：

```bash
bun run --bun vitest run --project browser src/pages/MembersPage.fixes.browser.test.tsx -t "rejects a new member that makes an existing policy principal ambiguous"
```

**期望 RED：**当前实现允许 POST，随后关闭创建框，无法得到错误字段状态；backend 多出用户。只有看到这一业务结果，才进入实现。不要把缺少标签或 runner 启动错误算 RED。

## 4. Task 2：用现有解析语义测试目录影响

**Files:** `src/domain/principal.ts`、`src/domain/principal.test.ts`。

- [ ] Task 1 已获得真实 RED 后，加入上述接口与先返回 `null` 的最小声明，并写负例。这是让纯函数测试可执行的临时阶段，不是完成实现。

```ts
test.each([
  ["alice-copy", "alice@example.test", { field: "email", principal: "alice@example.test" }],
  ["alice@example.test", "bob@example.test", { field: "name", principal: "alice@example.test" }],
  ["carol", "carol@example.test", null],
  ["carol", "", null],
] as const)("checks candidate %s / %s without changing existing owners", (name, email, expected) => {
  const users = [makeUser({ id: "1", name: "alice", email: "alice@example.test" })];
  expect(userCreationPrincipalConflict({ name, email }, users)).toEqual(expected);
});
```

- [ ] 运行单元用例，负例须因 `null` 与具体冲突不相等而失败，而非模块不存在。

```bash
bun run --bun vitest run --project unit src/domain/principal.test.ts
```

- [ ] 最小实现如下逻辑，避免另写一套邮箱身份解析器：

```ts
export function userCreationPrincipalConflict(
  candidate: Pick<HeadscaleUser, "name" | "email">,
  users: readonly HeadscaleUser[],
): UserCreationPrincipalConflict | null {
  const pending: PolicyUser = {
    name: candidate.name.trim(),
    email: candidate.email?.trim() ?? "",
    providerId: "",
  };
  const next = [...users, pending];
  for (const user of users) {
    for (const principal of userPolicyPrincipals(user, users)) {
      if (!userMatchesPolicyValue(user, principal, next)) {
        const identifier = principal.trim().replace(/@$/, "");
        return {
          field: pending.email === identifier ? "email" : "name",
          principal,
        };
      }
    }
  }
  return null;
}
```

- [ ] 增加字面 fixture 检查：已有 provider 标识的优先权不被改写；已有歧义目录中添加不相关用户不被全局封锁；既有用户对象不被修改；末尾 `@` 仍只按当前 helper 的一次剥离规则解析。期望值应手工列明，不用被测函数生成。
- [ ] 重跑单元测试，确认负例 GREEN、原有 principal 测试仍通过。不要为了更短实现改成简单大小写折叠或只比较 email 的集合。

## 5. Task 3：把检查接入真实提交边界

**Files:** `MembersPage.tsx` 和对应 browser 测试。

- [ ] 在 `createMember()` 的 POST 前读取 `identity`，从 session 最新 snapshot 取 users，不使用打开对话框时捕获的旧数组。
- [ ] 使用既有 `captureSession()`、`drafts.viewEpoch` 与单调的创建代际，拒绝退出、切服、关闭/重开或卸载后的旧提交。代际在 open/close/unmount 递增，不另造全局队列。
- [ ] 按以下顺序插入校验；保留现有 trim、表单提交锁和 mutation 至多派发一次语义：

```ts
const ownsSession = session.snapshot.captureSession();
const viewEpoch = session.drafts.getSnapshot().viewEpoch;
const generation = memberCreateGeneration.current;
const fresh = await session.snapshot.refreshSegments(["identity"]);
if (
  !ownsSession() ||
  generation !== memberCreateGeneration.current ||
  viewEpoch !== session.drafts.getSnapshot().viewEpoch ||
  !session.drafts.isCurrent()
) return;
if (!fresh) {
  setMemberPreflightError(copy.memberFreshReadRequired);
  return;
}
const conflict = userCreationPrincipalConflict(
  input,
  session.snapshot.getSnapshot().snapshot.users,
);
if (conflict) {
  memberForm.setFieldMeta(conflict.field, (meta) => ({
    ...meta,
    isTouched: true,
    errorMap: {
      ...meta.errorMap,
      onSubmit: `${copy.memberIdentityConflict} ${conflict.principal}`,
    },
  }));
  return;
}
const created = await mutate("create-member", { endpoint: "createUser", input });
if (created && ownsSession() && generation === memberCreateGeneration.current)
  closeMemberDialog();
```

该插入段需要定义 `memberCreateGeneration = useRef(0)`、`memberPreflightError` 本地状态；open/close/unmount 更新代际，open/close 清除该错误。网络读回失败在创建框内显示，不标成服务端拒绝创建。新文案分别为“必须重新读取用户目录，未发送创建请求”和“该身份会使现有策略引用歧义，请使用可区分的名称或邮箱”。

- [ ] 字段修改时清理该字段的 `errorMap.onSubmit`，复用 TanStack `setFieldMeta`；不得删除其他已有格式验证错误。重新输入唯一邮箱后应能正常创建。
- [ ] 先运行 Task 1 用例，再增加以下状态ful browser 回归：

| 输入/时序 | 必须观察的结果 |
| --- | --- |
| 点击后、提交前新目录出现同邮箱用户 | 不 POST；字段错误；保留输入 |
| identity GET 失败 | 不 POST；读回提示，不伪装创建失败或成功 |
| 读回等待期间切服/退出/卸载 | 新服务器没有 POST，旧结果不更新新页面 |
| 校正邮箱再提交 | 一次 POST；原输入规范化规则保持 |
| 连续 Enter/点击 | 一个显式提交至多派发一次 |
| 原来无冲突的用户名/空邮箱 | 不被新校验误封 |

- [ ] 运行完整文件及相关已有保护：

```bash
bun run --bun vitest run --project browser src/pages/MembersPage.fixes.browser.test.tsx
```

```bash
bun run --bun vitest run --project unit src/domain/principal.test.ts src/composables/useMutation-session.test.ts
```

## 6. Task 4：真实后端回归与收尾

- [ ] 复用现有隔离真实 Headscale fixture，不复用已经删除的十二人 namespace，也不 reset 他人 playground。
- [ ] 建立一条当前可达的邮箱组规则；经 UI 尝试危险新建，确认没有该 POST/新用户、策略原文不变、同源同端口仍可达。
- [ ] 增加不同邮箱的阳性对照；不要用只比较页面计数代替网络验证。
- [ ] 保留真实 Headscale 允许外部重复创建的事实，作为前端保证的边界，不把 server fixture 改成全局唯一。
- [ ] 在实施完成且无需其他主体修改源码后运行项目要求的完整检查；长测试后台执行并等退出结果。

```bash
bun run verify
```

## 7. 设计取舍与验收

这是前端受控入口的防护，不是跨所有客户端的服务端事务。GET→POST 间仍可能有外部并发创建，Headscale 0.29.4 也没有本项目可用的目录 CAS；不能承诺 exactly-once 或全局唯一。若要求全局消除该竞态，需要单独确认服务端约束，不应在本前端偷偷模拟锁或自动回滚其他用户。

**验收：**主要 browser RED 有真实失败记录；纯函数负例 RED/GREEN；新鲜读/切服/重复提交保护通过；真实既有流量未被新建破坏；无隐式改写既有引用；所有检查的未运行/失败均如实记录。

**自检：**源问题、保护边界、字段恢复、状态时序和后端残余竞态均有任务对应；没有用源码字符串匹配当行为测试，没有把“缺少导出”当 RED，没有未经授权的提交步骤。