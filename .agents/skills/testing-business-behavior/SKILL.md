---
name: testing-business-behavior
description: Use when writing, reviewing, or cleaning React/TypeScript tests, or deciding whether DOM, copy, CSS, generated output, or source-file assertions protect behavior.
---

# 业务行为测试

运行真实生产代码，保护公共接口与用户可观察的行为。先问：**哪一种错误的行为会使这个断言失败？** 按答案判断，不按文件名、是否挂载或匹配器名称判断。

## 判定边界

| 保留                                                                               | 清理                                                                      |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 输入校验、数据换算、请求参数、响应处理、权限、状态变化、竞态、组件事件、反馈与恢复 | 颜色、固定尺寸、布局、图标、装饰性 class、视觉快照                        |
| 无权限时按钮不出现、非法输入阻止提交、错误提示、换算后的业务文本                   | 仅比对翻译字典、静态文案常量或固定说明文字                                |
| 选中、禁用、展开、主题选择与恢复、焦点和键盘操作                                   | 用样式快照代替交互；只执行渲染辅助函数便声称覆盖业务                      |
| 隐私遮罩、秘密值不泄露、截图脱敏及恢复                                             | 与隐私或功能无关的整页像素、样式和尺寸比较                                |
| 执行真实函数、构建插件或脚本后的功能输出、文件副作用、退出码                       | 读取现成源码或配置后检查字符串、AST、编译结构、文件清单、哈希或二进制快照 |

DOM 的存在性、可见性、文本不是自动禁用。class 可定位控件，也可观察已有功能状态；主题切换和隐私遮罩不是装饰检查。`toContain` 可以检查执行结果，也可以检查源码，必须追溯数据来源。读取源码再 eval、编译或提取函数不能替代运行生产模块。

发布策略的具名例外：保留 `scripts/deployment-config.test.ts` 中现有的 CI 工件上传安全门禁，约束允许上传的路径、仅失败时上传、action 固定提交和短保留期。这些声明本身就是外部发布边界；不据此允许源码关键词、普通配置结构快照或自行增加例外，也不把它们当作运行时截图脱敏的证明。Git ignore 与 Docker 构建上下文排除则验证真实工具的执行结果。

## 编写与清理

1. 读测试、真实被测代码及调用者，明确输入、操作和可观察结果。组件通过 props、用户操作或公开事件驱动；已有独立纯函数直接测。不要为测试导出私有成员、暴露内部函数或强拆生产逻辑。
2. 逐条判断断言。混合用例只删除越界断言，保留驱动步骤与业务断言。整条无合规断言才删除用例，整个文件无合规用例才删除文件；随后清理无用 imports、fixtures 和辅助函数。
3. 保留有效的失败测试并如实报告。清理测试不授权修改产品行为；若夹具或等待方式错误，修正它们而不削弱原业务契约。
4. 删除导致覆盖率缺口时，检查真实消费者是否缺少有效行为用例。不得保留纯外观断言、空测试、无断言调用或只为覆盖率触发分支；不得降低阈值、扩大 exclude 或改生产实现换绿。无法同时满足时如实报告未完成的门禁。
5. mock 放在依赖边界，保留被测业务。循环导入导致异步 `importOriginal()` 挂起时先查依赖环，再用最小同步 mock；不靠增加超时、关闭隔离、吞异常或机械使用 `spy: true` 掩盖问题。

## 本项目环境

- 使用 `packageManager` 固定的 Bun；定向运行也使用 `bun run --bun vitest run <测试文件>`，避免可执行文件的 Node shebang 改变运行时。沿用 `vitest.config.ts` 中的 `unit`、真实 Chromium `browser`、`toolchain` 分组，不照搬其他仓库的 pnpm、Google Chrome channel 或 Node 例外清单。
- 浏览器组件不使用 Node 文件系统 API，也不迁到模拟 DOM 环境规避失败。脚本和构建测试按真实运行环境验证，不能改为源码检查。
- 保留四项逐文件 100% 覆盖率、Lingui 完整性检查与独立的 `bun run e2e`。纯静态文案断言清理不取消语言切换、插值、复数和错误反馈测试。
- E2E 继续使用隔离的可丢弃 Headscale；验证 GUI 校验、请求、公开 API 回读、反馈和恢复，不扩大为 SSH、网络数据面或服务端原子性验收。失败截图只能来自测试夹具，保留隐私保护。
- 不新增 skip、only 或环境例外来隐藏失败。现有的平台条件测试按其真实运行范围保留，报告实际跳过数量及条件；定向测试只作迭代反馈，不能替代完整验收。

## 行为例子

[CopyButton 测试](../../../src/components/app/copy-button.browser.test.tsx) 挂载真实组件，只替换浏览器剪贴板边界，验证写入内容和成功反馈。下面使用该文件已有的 `stubClipboard` 与 `mount`：

```tsx
const writes: string[] = [];
stubClipboard(async (value) => {
  writes.push(value);
});
await mount(
  <CopyButton value="secret" data-testid="copy">
    Copy
  </CopyButton>,
);
await page.getByTestId("copy").click();
expect(writes).toEqual(["secret"]);
await expect.element(page.getByTestId("copy")).toHaveTextContent("Copied");
```

这里的 `Copied` 是操作成功后的反馈，不是单独锁定翻译常量。若同一用例还检查按钮宽度，只清理宽度断言，不能删除剪贴板写入与反馈验证。

## 验收与交付

依次运行 [AGENTS.md 的五项门禁](../../../AGENTS.md#before-the-change-is-done)，每条命令独立退出 0 才算通过。watch、局部测试和 CI 通过均不能替代规定的本地全量检查。

交付说明写明清理范围、保留的业务与安全边界、实际命令和退出码、覆盖率、跳过条件、剩余失败及未验证项。用例数量减少不代表业务缺陷已修复。本技能不授权提交、推送、发布或修改无关文件。
