# SDD ledger — plan: reports/remediation-2026-10-26/G01-身份歧义-TDD方案.md

## Preflight

| 任务/接口 | 核对 | 结论 |
| --- | --- | --- |
| 浏览器RED→纯函数→提交边界 | fake后端继续接受重复身份；不能把不存在导出当RED | 先现有UI业务失败，随后类型骨架与纯函数负例 |
| Task 2 principal → Task 3 UI | 同一纯函数签名、trim/单次尾@/provider优先 | 一致，复用现有解析而非全局邮箱唯一 |
| Task 3表单→Task 4真实后台 | UI不派发危险POST、旧策略与流量保持 | 需要真实fixture限定验证，不用页面计数替代 |
| G01→G02 共享descriptors/locales | 后一任务会接上前一翻译结果 | 串行writer，避免抽取/编译与浏览器测试交叉 |
| 当前workspace→review | HEAD有上一轮未提交补丁 | 以本次before snapshot比较增量，不用HEAD..HEAD空差异 |

Ruling: 在用户明确要求的当前非main脏工作区执行，保留上一轮改动，不另建需提交的worktree — 避免丢失已批准UI修正 — 若判断错误，需从before快照恢复本轮局部修改，不能reset整个仓库。

Ruling: 按bug聚合本方案中相互依赖的RED/helper/UI/i18n步骤为一个实施单元，G01后G02 — 中间红测试与返回null接口不应单独交付 — 成本是单次任务review覆盖整个小功能。

Ruling: 禁止提交推送优先于skill提交步骤，review包使用before/after文件差异 — 用户只批准工作区实施 — 成本是临时快照和证据需在收尾归档，不能依赖提交历史。

Task G01: in_progress

## Dispatch / 2026-10-26T12:29:12.355583+08:00

Task G01: implementer=g01-tdd-implementer (a16aa9779a5b97601), model=sonnet; source writer active; no commits.

Task G01: RED verified by controller — G01-red-browser.log exit1; expected no POST, actual POST /api/v1/user with alice-copy/alice@example.com accepted by stateful transport. Not a compile/selector/runner error.

G02 preparation: existing tag-lifecycle-real lane already exposes private login request handoff, real snapshots, HTTP probes and owned cleanup; no need new fleet/host capability. Read-only preparation only; G02 source not changed.

Task G01: implementer DONE, report read; incremental review package generated from starting snapshot. Real live lane reused existing tagFixtureRegisterKey; no fixture/config API changes.

Ruling: G01 real regression uses the existing tag-lifecycle lane instead of adding a second network fixture to the generic headscale-ui lane — same UI/data-plane acceptance with smaller change — if wrong, the full legacy lifecycle lane must expose a compatibility regression before acceptance.

Task G01: review in_progress — g01-task-reviewer (ad7b259b4437cfa38), model=opus; brief/report/incremental snapshot package handed off. No next source writer until task review accepted.

Task G01: controller checked real lane log — 1 passed / 18 filtered-out, 22.23s; no current io.headscale-ui.tag-lifecycle containers/networks/volumes and no running preview. Other lane cases not claimed as run.

Task G01: review Spec compliant / Task Quality Approved; no confirmed findings. Reviewer returned body due report-write constraint, coordinator serialized it without adding claims.

Task G01: complete (no commits, starting dirty snapshot -> G01 incremental package, review clean). Lint exit-detail limitation will be resolved by final unified static check.

Final source/test freeze captured before integrated full verification; only31 combined scoped files differ from the original dirty snapshot. No commits. G02 scoped reviewer closed all3 findings; final2 empty-input tests alter tests only, production hash unchanged.

Integration E2E first run exit1: primary lane88pass/1fail, later lanes not run. Existing post-write-refresh test intercepted new G01 preflight GET, so safe0POST contradicted its oldexpected1. Test-only timing adaptation assigned g01-e2e-boundary(a3f9bf1cb3bd8a16d), production guard must remain unchanged; no green claim before actual rerun.

Final whole-change verification complete: G01 reviewclean, G02 scopedreview3 addressed/no new important; allchecks executed, no commits/push. MainE2E timingcompatibility reviewed inline and full rerun exit0.
