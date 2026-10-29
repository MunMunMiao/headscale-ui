# SDD ledger — plan: reports/remediation-2026-10-26/G02-恢复基线-TDD方案.md

## Preflight

| 任务/接口 | 核对 | 结论 |
| --- | --- | --- |
| Task1真实序列→Task2受控RED | 原报告没有逐次API；正常控制组可能通过 | 必须记录真实差异；不能造响应证明陈旧state |
| Task2重读→Task3重新审阅 | 未派发可重建，已派发只观察 | 需显式派发阶段，不恢复已消费ID |
| Task3物理关联→Task4安全反例 | machineKey存在且唯一；缺失/异主/跨会话失败 | 不能仅同nodeId接纳新身份；保护原比较 |
| Task3新UI→既有恢复观察 | 同节点已成目标个人可仅读回匹配 | 不派发第二次authRegister |
| Task4→Task5真实后端 | fixture提供可信keyless请求/真实HTTP及清理 | 不用图标/通知替业务效果 |
| G01→G02共享i18n/e2e文件 | baseline已含审阅通过G01和816条语言目录 | 串行增量保留G01测试/旧UI变化 |

Ruling: 延续用户指定的当前工作区与禁止提交推送，review按包含G01的before快照比较 — 避免把已接受G01混入G02新差异 — 成本是额外快照与归档，不能reset整仓。

Ruling: G02所有耦合子步骤按一个恢复功能任务执行 — RED/重审/观察安全互相依赖 — 成本是单次审阅涵盖状态与真实后端，但不拆成互相冲突的writer。

Task G02: in_progress; G01 complete/review clean before dispatch.

Task G02: implementer=g02-tdd-implementer (a71f428bddd86501f), model=opus, DONE_WITH_CONCERNS only because report write unavailable; coordinator archived supplied body. Source frozen, 27 incremental files.

Ruling: 原稳定复合流程已在真实旧实现通过，作为控制组；修复对象限定为真实合法标签变化后无提交前重审入口 — 不虚构历史唯一根因 — 若边界不完整，独立审阅及负例需指出而不能改弱身份保护。

Ruling: 接受restoreReviewReady作为显式本地门控来阻止重读失败后仅勾选重新授权，并将freshness false→true 单次代际恢复交独立审阅严格核实 — 单纯文案/清复选框不构成fail-closed — 若错误，可能错误拒绝或接纳旧读回，需修复后再验收。

Ruling: 真实lane配置关闭失败截图以避免短时认证信息持久化，不关闭测试/断言/覆盖门槛 — CLI开关未生效且已有遮罩仅防字形 — 成本是依赖脱敏文本诊断而非真实请求失败图。

Task G02: task/final combined review package generated; review pending.

Task G02: review request changes — I1 final pre-read unique-machine check missing; I2 explicit new request still bound to prior submitted attempt; I3 failing real-token empty-value matcher can print secret. Full review body archived by coordinator.

Ruling: 修正I2的计划缺陷，提交阶段必须绑定用户显式新请求/新尝试，而不是整个窗口 — 既有产品允许unknown后同窗输入新的可信请求 — 若错会造成误重放或旧基线复活，必须先用新请求/旧请求安全对照RED再验收。

Ruling: 删除仅显示层的空标签fallback而不为不可达状态造测试 — 三个入口都要求tags非空且重读只安装非空基线，覆盖代理核实不可达 — 若未来新增空基线入口，需新增真实行为与显示测试；不能用coverage ignore。

Task G02: fix round 1 pending; original implementer not reachable after session transition, use a fresh implementer with report/brief/findings; coverage-only reader made zero edits.

Task G02: fix round1 implementer=g02-safety-fix (a16f1c9cb6eb7b860), model=opus, DONE; exact three-file delta, no locale/G01 changes. Reviewer recheck pending; full161 browser/47unit/real6 logs available.

Task G02: fix round1/5 (3 addressed, 0 open — I1/I2/I3 all ADDRESSED, reviewer g02-and-final-reviewer a4e83b0285d82976f; no commits). Task quality/spec and combined safety approved for frozen source; no new important findings.

Task G02: integrated behavior3436 pass/3 pre-existing skip; coverage exit1 due only onInput trim-empty branch at2634. Test-only supplement assigned to existing fix agent, production source unchanged. This is coverage closure, not a new productRED or relaxedthreshold.

Final source/test freeze captured before integrated full verification; only31 combined scoped files differ from the original dirty snapshot. No commits. G02 scoped reviewer closed all3 findings; final2 empty-input tests alter tests only, production hash unchanged.

Task G02: complete (no commits, fix round1/5 clean; test-only blank-input additions complete). Final integrated suite3438pass/3pre-existing skip,114files four metrics100%; static/i18n820/build passed; fullE2E89+23+67 and downstreampolicy/session/deployment exit0. No source changed after reviewed freeze; only existingmainE2E gate timing adapted preservingassertions.
