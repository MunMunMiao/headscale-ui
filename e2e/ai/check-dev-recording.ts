import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { waitUntil } from "../../scripts/harness/wait-until";

const recordings = new URL("../../.claude/ai-e2e/runs/", import.meta.url);
const browser = await chromium.launch({ headless: true });
let recordingDirectory: string | undefined;
try {
  const page = await browser.newPage();
  let connected = false;
  const reloads: unknown[] = [];
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      const text = typeof payload === "string" ? payload : payload.toString();
      if (!text.startsWith("{")) return;
      const event = JSON.parse(text) as { type?: string };
      if (event.type === "connected") connected = true;
      if (event.type === "full-reload") reloads.push(event);
    });
  });
  await page.goto(
    new URL("/login", process.argv[2] ?? "http://127.0.0.1:5173").href,
  );
  await page.getByTestId("profile-option-new").waitFor();
  await waitUntil(async () => connected, { timeoutMsg: "Vite HMR 未连接" });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  reloads.length = 0;
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  await mkdir(recordings, { recursive: true, mode: 0o700 });
  recordingDirectory = await mkdtemp(
    fileURLToPath(new URL("recording-check-", recordings)),
  );
  await writeFile(
    `${recordingDirectory}/result.md`,
    "AI E2E recording isolation probe\n",
    {
      mode: 0o600,
    },
  );
  // 否定断言必须留出实际文件监听的观测窗口；页面加载和 HMR 连接已按条件等待。
  await Bun.sleep(1500);
  assert.equal(reloads.length, 0, "写入 AI 测试记录不应触发 Vite 整页重载");
  assert.equal(
    await page.evaluate(() => performance.timeOrigin),
    timeOrigin,
    "受测页面应保持原文档",
  );
  console.log("PASS AI 记录文件变化不触发页面重载");
} finally {
  await Promise.all([
    browser.close(),
    recordingDirectory
      ? rm(recordingDirectory, { recursive: true, force: true })
      : undefined,
  ]);
}
