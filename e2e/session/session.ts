import assert from "node:assert/strict";
import type { Browser, Page } from "playwright";
import { computeBuildId } from "../../scripts/build-id";
import type { DeploymentConnection } from "../../scripts/harness/deployment-stack";
import { root } from "../../scripts/harness/docker";
import { evaluateSharedWorker } from "../../scripts/harness/shared-worker-probe";
import { waitUntil } from "../../scripts/harness/wait-until";
import type { PublicSessionSnapshot } from "../../src/session/types";

interface Observation {
  tab: string;
  sourceOrigin: string;
  users: string[];
  httpStatus: number;
  authorizedControlVisible: boolean;
  authorizedControlEnabled: boolean;
}
// Same business assertion that failed against the preserved pre-change production build.
function assertSingleCurrentServer(
  observations: readonly Observation[],
  current: Pick<DeploymentConnection, "baseUrl" | "user">,
) {
  for (const observation of observations) {
    assert.deepEqual(
      { sourceOrigin: observation.sourceOrigin, users: observation.users },
      { sourceOrigin: new URL(current.baseUrl).origin, users: [current.user] },
      `${observation.tab}: every authorized peer must use the last successfully selected server B`,
    );
  }
}

async function hello(page: Page, workerUrl: string, protocolVersion = 1) {
  return page.evaluate(
    ({ workerUrl, protocolVersion }) =>
      new Promise<{
        type: string;
        workerId?: string;
        buildId?: string;
        snapshot?: PublicSessionSnapshot;
        error?: { kind: string };
      }>((resolve, reject) => {
        const worker = new SharedWorker(workerUrl, {
          type: "module",
          name: "headscale-ui-session",
        });
        const timer = setTimeout(() => {
          worker.port.close();
          reject(new Error("Probe handshake timeout"));
        }, 10000);
        worker.port.onmessage = (event) => {
          clearTimeout(timer);
          worker.port.postMessage({ type: "disconnect" });
          worker.port.close();
          resolve(event.data);
        };
        worker.port.postMessage({
          type: "hello",
          protocolVersion,
          storageVersion: 3,
          buildId: "deployment-compatible-page",
          ownerTabId: "deployment-protocol-probe",
        });
      }),
    { workerUrl, protocolVersion },
  );
}

async function saveAndEnter(
  page: Page,
  connection: Pick<DeploymentConnection, "baseUrl" | "apiKey">,
  name: string,
  password: string,
  remember = true,
) {
  await page.bringToFront();
  await page.getByTestId("profile-option-new").click();
  await page.getByTestId("connect-profile-name").fill(name);
  await page.getByTestId("connect-server-url").fill(connection.baseUrl);
  await page.getByTestId("connect-api-key").fill(connection.apiKey);
  await page.getByTestId("connect-password").fill(password);
  await page.getByTestId("connect-password-confirm").fill(password);
  if (!remember) await page.getByTestId("connect-remember").click();
  await page.getByTestId("connect-save-unlock").click();
  await page.getByTestId("section-home").waitFor({ state: "visible" });
}
async function beginUnlock(page: Page, name: string, password: string) {
  await page.bringToFront();
  await page.getByTestId(`profile-option-${name}`).click();
  await page.getByTestId("unlock-passphrase").fill(password);
  await page.getByTestId("unlock-submit").click();
}
async function unlock(page: Page, name: string, password: string) {
  await beginUnlock(page, name, password);
  await page.getByTestId("section-home").waitFor({ state: "visible" });
}
async function logout(page: Page) {
  await page.bringToFront();
  await page.getByTestId("profile-menu-trigger").click();
  await page.getByTestId("logout").click();
  await page.getByTestId("profile-option-new").waitFor({ state: "visible" });
}
/** Closes whatever dialog is open, then opens the server settings on the API keys tab. */
async function openApiKeySettings(page: Page) {
  await page.bringToFront();
  const dialog = page.getByTestId("server-settings-dialog");
  for (let attempt = 0; attempt < 3 && (await dialog.isVisible()); attempt++) {
    await page.keyboard.press("Escape");
    await Bun.sleep(300);
  }
  await page.getByTestId("profile-menu-trigger").click();
  await page.getByTestId("open-server-settings").click();
  await page
    .getByTestId("create-api-key-confirm")
    .waitFor({ state: "visible" });
}
async function members(page: Page, connection: DeploymentConnection) {
  await page.bringToFront();
  await page.getByTestId("section-members").click();
  await page
    .getByTestId(`member-${connection.user}`)
    .waitFor({ state: "visible" });
  await waitUntil(() => page.getByTestId("refresh-users").isEnabled());
}
async function observe(
  page: Page,
  tab: string,
  connections: DeploymentConnection[],
  current: DeploymentConnection,
): Promise<Observation> {
  await page.bringToFront();
  await page.getByTestId("refresh-users").waitFor({ state: "visible" });
  await waitUntil(() => page.getByTestId("refresh-users").isEnabled());
  for (const connection of connections) connection.network.clearObservations();
  await page.getByTestId("refresh-users").click();
  const reads = () =>
    connections.flatMap((connection) =>
      connection.network
        .getObservations()
        .filter(
          (entry) => entry.method === "GET" && entry.path === "/api/v1/user",
        )
        .map((entry) => ({ connection, entry })),
    );
  await waitUntil(async () =>
    reads().some(({ entry }) => entry.status === 200),
  );
  await waitUntil(() => page.getByTestId("refresh-users").isEnabled());
  // 切换前台会触发可见性刷新，30 秒轮询也可能与手动刷新相邻；检查全部读取的来源，
  // 不把合法的额外读取当作失败，也不能只检查第一条而漏掉旧服务器请求。
  const observed = reads();
  for (const { connection } of observed)
    assert.equal(
      connection.baseUrl,
      current.baseUrl,
      `${tab}: every refresh uses the current server`,
    );
  const source = observed.find(
    ({ entry }) => entry.status === 200 && !entry.aborted,
  );
  assert.ok(source, `${tab}: refresh completes with an authenticated response`);
  await page
    .getByTestId(`member-${source.connection.user}`)
    .waitFor({ state: "visible" });
  const users: string[] = [];
  for (const connection of connections)
    if (await page.getByTestId(`member-${connection.user}`).isVisible())
      users.push(connection.user);
  return {
    tab,
    sourceOrigin: new URL(source.connection.baseUrl).origin,
    users,
    httpStatus: source.entry.status ?? 0,
    authorizedControlVisible: await page
      .getByTestId("refresh-users")
      .isVisible(),
    authorizedControlEnabled: await page
      .getByTestId("refresh-users")
      .isEnabled(),
  };
}

export async function checkSession(
  browser: Browser,
  origin: string,
  connections: { a: DeploymentConnection; b: DeploymentConnection },
) {
  const { a, b } = connections;
  assert.notEqual(a.baseUrl, b.baseUrl);
  assert.notEqual(a.apiKey, b.apiKey);
  assert.notEqual(a.user, b.user);
  const context =
    browser.contexts()[0] ??
    (await browser.newContext({ viewport: { width: 1366, height: 768 } }));
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  const workerUrl = `${origin}/shared-session-worker.js`;
  const errors: string[] = [];
  const watch = (page: Page) => {
    page.setDefaultTimeout(20000);
    page.on("pageerror", (error) => errors.push(error.message));
  };
  watch(pageA);
  watch(pageB);
  let frozen = false;
  const cdp = await context.newCDPSession(pageA);
  try {
    await pageA.goto(`${origin}/login`);
    await pageB.goto(`${origin}/login`);
    await saveAndEnter(pageA, a, "Server-A", "password-A");
    await members(pageA, a);
    await pageB.bringToFront();
    await pageB.goto(`${origin}/members`);
    await pageB.getByTestId(`member-${a.user}`).waitFor({ state: "visible" });
    const sharedA = await hello(pageA, workerUrl);
    assert.equal(sharedA.type, "hello");
    assert.equal(
      sharedA.buildId,
      computeBuildId(root),
      "the deployed Worker was built from exactly the sources in this checkout",
    );
    const initialExpiry = sharedA.snapshot?.expiresAt ?? 0;
    assert.ok(initialExpiry > Date.now() + 29 * 60 * 1000);
    await Bun.sleep(1100);
    await pageB.bringToFront();
    assert.equal(
      (await hello(pageB, workerUrl)).snapshot?.expiresAt,
      initialExpiry,
      "focus does not renew the deadline",
    );
    await pageB.keyboard.press("Tab");
    await waitUntil(
      async () =>
        ((await hello(pageA, workerUrl)).snapshot?.expiresAt ?? 0) >
        initialExpiry,
    );
    assert.equal(
      (await hello(pageA, workerUrl)).snapshot?.expiresAt,
      (await hello(pageB, workerUrl)).snapshot?.expiresAt,
      "trusted peer activity renews the one global deadline",
    );
    assert.equal(
      (await hello(pageB, workerUrl)).workerId,
      sharedA.workerId,
      "independent pages share one Worker",
    );
    await pageA.bringToFront();
    await pageA.reload();
    await pageA.getByTestId(`member-${a.user}`).waitFor({ state: "visible" });
    assert.equal(
      (await hello(pageA, workerUrl)).snapshot?.identity?.sessionId,
      sharedA.snapshot?.identity?.sessionId,
      "peer keeps a refreshed page in the same session",
    );
    await pageB.goto(`${origin}/login`);
    await saveAndEnter(pageB, b, "Server-B", "password-B");
    await pageA.bringToFront();
    await pageA.getByTestId(`member-${b.user}`).waitFor({ state: "visible" });
    await members(pageB, b);
    const observations = [
      await observe(pageA, "A-after-B-login", [a, b], b),
      await observe(pageB, "B-after-B-login", [a, b], b),
    ];
    assertSingleCurrentServer(observations, b);
    console.log(
      "PASS original two-Headscale shared-session assertion",
      JSON.stringify(observations),
    );

    const good = await hello(pageA, workerUrl);
    assert.equal(
      (await hello(pageB, workerUrl, 999)).error?.kind,
      "reload-required",
    );
    assert.deepEqual(
      (await hello(pageA, workerUrl)).snapshot?.identity,
      good.snapshot?.identity,
      "incompatible peer does not fork or replace the session",
    );
    await logout(pageB);
    await pageA.getByTestId("profile-option-new").waitFor({ state: "visible" });
    assert.equal((await hello(pageA, workerUrl)).snapshot?.status, "locked");

    // Hold the actual candidate validation response while a peer tries another unlock.
    const candidate = a.network.intercept({
      method: "GET",
      pathPattern: "^/api/v1/user$",
    });
    try {
      await beginUnlock(pageA, "Server-A", "password-A");
      await waitUntil(async () => candidate.getSnapshot().captured);
      await beginUnlock(pageB, "Server-B", "password-B");
      await pageB.getByTestId("unlock-error").waitFor({ state: "visible" });
      assert.match(
        (await pageB.getByTestId("unlock-error").textContent()) ?? "",
        /progress|wait|busy/i,
      );
      assert.equal(
        (await hello(pageB, workerUrl)).snapshot?.pendingProfileId,
        (await hello(pageA, workerUrl)).snapshot?.pendingProfileId,
      );
      await pageB.getByTestId("unlock-cancel").click();
      await candidate.release();
      await pageA.bringToFront();
      await pageA.getByTestId("section-home").waitFor({ state: "visible" });
    } finally {
      await candidate.release();
    }
    await pageB.goto(`${origin}/members`);
    await members(pageA, a);

    // Close a peer, not a BFCache-preserved document, with its own read pending.
    const departing = await context.newPage();
    watch(departing);
    await departing.bringToFront();
    await departing.goto(`${origin}/members`);
    await departing
      .getByTestId(`member-${a.user}`)
      .waitFor({ state: "visible" });
    await waitUntil(() => departing.getByTestId("refresh-users").isEnabled());
    const pending = a.network.intercept({
      method: "GET",
      pathPattern: "^/api/v1/user$",
    });
    try {
      await departing.getByTestId("refresh-users").click();
      await waitUntil(async () => pending.getSnapshot().captured);
      await departing.close();
      await waitUntil(
        async () =>
          a.network
            .getObservations()
            .some(
              (entry) =>
                entry.gateId === pending.getSnapshot().id && entry.aborted,
            ),
        {
          timeout: 2000,
          timeoutMsg:
            "Closing a port must abort its held read before the HTTP timeout",
        },
      );
      await observe(pageB, "B-after-peer-disconnect", [a, b], a);
      assert.equal(
        (await hello(pageB, workerUrl)).snapshot?.status,
        "unlocked",
      );
    } finally {
      await pending.release();
      if (!departing.isClosed()) await departing.close();
    }
    await pageA.bringToFront();
    await pageA.getByTestId(`member-${a.user}`).waitFor({ state: "visible" });
    console.log(
      "PASS candidate exclusion, per-port cancellation, peer reload, compatible/incompatible protocol, and global logout",
    );

    // Preserve a member draft on A, then prove none of it can reach B after the switch.
    await pageA.bringToFront();
    const oldRead = a.network.intercept({
      method: "GET",
      pathPattern: "^/api/v1/user$",
    });
    try {
      // The held read belongs to the stale tab itself; the modal dialog would block this click later.
      await pageA.getByTestId("refresh-users").click();
      await waitUntil(async () => oldRead.getSnapshot().captured);
      await pageA.getByTestId("open-create-member").click();
      await pageA.getByTestId("member-name").fill("draft-belongs-to-a");
      await pageB.bringToFront();
      await pageB.goto(`${origin}/login`);
      await unlock(pageB, "Server-B", "password-B");
      await pageA.bringToFront();
      await pageA
        .getByTestId("stale-session-draft-dialog")
        .waitFor({ state: "visible" });
      assert.equal(
        await pageA.getByTestId("member-name").inputValue(),
        "draft-belongs-to-a",
      );
      a.network.clearOperationCalls();
      b.network.clearOperationCalls();
      // The modal blocks pointer clicks; a submit event still reaches the form.
      await pageA.getByTestId("member-form").evaluate((form) => {
        (form as HTMLFormElement).requestSubmit();
      });
      await hello(pageA, workerUrl);
      for (const [label, connection] of [
        ["A", a],
        ["B", b],
      ] as const)
        assert.equal(
          connection.network
            .getOperationCalls()
            .filter((call) => call.id === "user.create").length,
          0,
          `a stale submit must not create a member on ${label}`,
        );
      await pageA
        .getByTestId("stale-session-draft-dialog")
        .waitFor({ state: "visible" });
      assert.equal(
        await pageA.getByTestId("member-name").inputValue(),
        "draft-belongs-to-a",
      );
      // The switch cancels the old session's held read (auth-session.ts cancels pending observations).
      await waitUntil(
        async () =>
          a.network
            .getObservations()
            .some(
              (entry) =>
                entry.gateId === oldRead.getSnapshot().id && entry.aborted,
            ),
        {
          timeout: 2000,
          timeoutMsg: "A server switch must abort the old session's held read",
        },
      );
      await oldRead.release();
      await pageA.getByTestId("discard-stale-session-draft").click();
      await pageA.getByTestId(`member-${b.user}`).waitFor({ state: "visible" });
      assert.equal(await pageA.getByTestId("member-name").count(), 0);
      assert.equal(
        await pageA.getByTestId(`member-${a.user}`).count(),
        0,
        "the previous server's members are gone after discard",
      );
      assertSingleCurrentServer(
        [await observe(pageA, "A-after-discard", [a, b], b)],
        b,
      );
    } finally {
      await oldRead.release();
    }
    console.log(
      "PASS late A response and A draft cannot overwrite or write to B",
    );

    // Native lifecycle freeze queues the write reply; a peer lock must invalidate it before paint.
    await openApiKeySettings(pageA);
    const write = b.network.intercept({
      method: "POST",
      pathPattern: "^/api/v1/apikey$",
    });
    await pageA.evaluate(() => {
      sessionStorage.setItem("deployment-freeze", "0");
      sessionStorage.setItem("deployment-resume", "0");
      sessionStorage.setItem("deployment-key-flash", "0");
      document.addEventListener("freeze", () =>
        sessionStorage.setItem("deployment-freeze", "1"),
      );
      document.addEventListener("resume", () =>
        sessionStorage.setItem("deployment-resume", "1"),
      );
      const observer = new MutationObserver(() => {
        if (document.querySelector('[data-testid="created-api-key"]'))
          sessionStorage.setItem("deployment-key-flash", "1");
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    try {
      await pageA.getByTestId("create-api-key-confirm").click();
      await waitUntil(async () => write.getSnapshot().captured);
      assert.equal(
        write.getSnapshot().upstreamRequests,
        1,
        "write really committed before its reply was held",
      );
      await pageB.bringToFront();
      assert.equal(
        await pageA.evaluate(() => document.visibilityState),
        "hidden",
      );
      await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
      frozen = true;
      await write.release();
      await logout(pageB);
      await cdp.send("Page.setWebLifecycleState", { state: "active" });
      frozen = false;
      await pageA.bringToFront();
      await pageA
        .getByTestId("profile-option-new")
        .waitFor({ state: "visible" });
      assert.deepEqual(
        await pageA.evaluate(() =>
          [
            "deployment-freeze",
            "deployment-resume",
            "deployment-key-flash",
          ].map((key) => sessionStorage.getItem(key)),
        ),
        ["1", "1", "0"],
      );
      assert.equal(
        b.network
          .getOperationCalls()
          .filter((call) => call.id === "apikey.create").length,
        1,
        "recovery never replays a one-time write",
      );
    } finally {
      if (frozen) {
        await cdp.send("Page.setWebLifecycleState", { state: "active" });
        frozen = false;
      }
      await write.release();
    }
    console.log(
      "PASS actual freeze/resume refuses a committed write reply after peer logout, with no key flash or write replay",
    );

    // A reply received while hidden stays pending beyond the normal 20-second reply deadline.
    await unlock(pageA, "Server-B", "password-B");
    await pageB.goto(`${origin}/home`);
    await pageA.bringToFront();
    await openApiKeySettings(pageA);
    b.network.clearOperationCalls();
    const hiddenWrite = b.network.intercept({
      method: "POST",
      pathPattern: "^/api/v1/apikey$",
    });
    try {
      await pageA.getByTestId("create-api-key-confirm").click();
      await waitUntil(async () => hiddenWrite.getSnapshot().captured);
      await pageB.bringToFront();
      assert.equal(
        await pageA.evaluate(() => document.visibilityState),
        "hidden",
      );
      await hiddenWrite.release();
      await Bun.sleep(21000);
      assert.equal(
        await pageA.getByTestId("created-api-key").count(),
        0,
        "hidden page defers the credential",
      );
      assert.equal(
        await pageA.getByTestId("error-screen").count(),
        0,
        "received reply is no longer a communication timeout",
      );
      await pageA.bringToFront();
      await pageA.getByTestId("created-api-key").waitFor({ state: "visible" });
      assert.equal(await pageA.getByTestId("created-api-key").count(), 1);
      assert.equal(
        b.network
          .getOperationCalls()
          .filter((call) => call.id === "apikey.create").length,
        1,
      );
      await pageA.keyboard.press("Escape");
    } finally {
      await hiddenWrite.release();
    }
    console.log(
      "PASS hidden page receives a one-time key, survives the communication deadline, and displays it once after revalidation",
    );

    // A write whose reply is lost after the upstream commit must surface an outcome and never replay.
    const apiKeyCreates = () =>
      b.network
        .getOperationCalls()
        .filter((call) => call.id === "apikey.create").length;
    const outcomeSurface = async (page: Page, timeout: number) => {
      let surface = "";
      await waitUntil(
        async () => {
          if (await page.getByTestId("api-key-create-error").isVisible())
            surface = "api-key-create-error";
          else if (await page.getByTestId("api-key-create-notice").isVisible())
            surface = "api-key-create-notice";
          else if (await page.getByTestId("error-screen").isVisible())
            surface = "error-screen";
          return surface !== "";
        },
        {
          timeout,
          timeoutMsg: "A lost write reply must end in a visible outcome",
        },
      );
      return surface;
    };
    const assertNoKeyAnywhere = async () => {
      for (const page of [pageA, pageB])
        assert.equal(
          await page.getByTestId("created-api-key").count(),
          0,
          "no key is displayed",
        );
    };
    const assertNoReplay = async (label: string) => {
      // A hidden page holds Worker results until it is visible, so bring it forward first.
      await pageA.bringToFront();
      await pageA.reload();
      await pageA.getByTestId("section-home").waitFor({ state: "visible" });
      await Bun.sleep(1500);
      assert.equal(
        apiKeyCreates(),
        1,
        `${label}: a lost write is never replayed`,
      );
    };
    for (const [label, failure] of [
      ["drop after commit", { drop: true }],
      ["502 after commit", { rawBody: "bad gateway", status: 502 }],
    ] as const) {
      b.network.clearOperationCalls();
      const fault = b.network.intercept({
        method: "POST",
        pathPattern: "^/api/v1/apikey$",
        failure,
      });
      try {
        await openApiKeySettings(pageA);
        await pageA.getByTestId("create-api-key-confirm").click();
        await waitUntil(async () => fault.getSnapshot().captured);
        await fault.release();
        const surface = await outcomeSurface(pageA, 20000);
        assert.equal(
          fault.getSnapshot().upstreamRequests,
          1,
          `${label}: one upstream write`,
        );
        assert.equal(apiKeyCreates(), 1, `${label}: one write at the proxy`);
        await assertNoKeyAnywhere();
        await assertNoReplay(label);
        console.log(
          `PASS write fault (${label}) surfaced ${surface} without key or replay`,
        );
      } finally {
        await fault.release();
      }
    }

    b.network.clearOperationCalls();
    const slow = b.network.intercept({
      method: "POST",
      pathPattern: "^/api/v1/apikey$",
    });
    try {
      await openApiKeySettings(pageA);
      await pageA.getByTestId("create-api-key-confirm").click();
      await waitUntil(async () => slow.getSnapshot().captured);
      // The Worker's 15 s HTTP timeout must fire while the reply is still held.
      const surface = await outcomeSurface(pageA, 25000);
      assert.equal(
        slow.getSnapshot().released,
        false,
        "the outcome appeared before any release",
      );
      await slow.release();
      assert.equal(
        slow.getSnapshot().upstreamRequests,
        1,
        "HTTP timeout: one upstream write",
      );
      assert.equal(apiKeyCreates(), 1, "HTTP timeout: one write at the proxy");
      await assertNoKeyAnywhere();
      await assertNoReplay("HTTP timeout");
      console.log(
        `PASS write held past the HTTP timeout surfaced ${surface} without key or replay`,
      );
    } finally {
      await slow.release();
    }

    b.network.clearOperationCalls();
    const closing = b.network.intercept({
      method: "POST",
      pathPattern: "^/api/v1/apikey$",
    });
    const second = await context.newPage();
    watch(second);
    try {
      await second.goto(`${origin}/home`);
      await second.getByTestId("section-home").waitFor({ state: "visible" });
      await openApiKeySettings(second);
      await second.getByTestId("create-api-key-confirm").click();
      await waitUntil(async () => closing.getSnapshot().captured);
      await second.close();
      await waitUntil(
        async () =>
          b.network
            .getObservations()
            .some(
              (entry) =>
                entry.gateId === closing.getSnapshot().id && entry.aborted,
            ),
        {
          timeout: 2000,
          timeoutMsg: "Closing a port must abort its held write",
        },
      );
      await closing.release();
      assert.equal(
        closing.getSnapshot().upstreamRequests,
        1,
        "port close: one upstream write",
      );
      assert.equal(apiKeyCreates(), 1, "port close: one write at the proxy");
      assert.equal(
        (await hello(pageA, workerUrl)).snapshot?.status,
        "unlocked",
      );
      await assertNoKeyAnywhere();
      await assertNoReplay("port close");
      console.log(
        "PASS closing a page with a held write aborts it while peers stay unlocked",
      );
    } finally {
      await closing.release();
      if (!second.isClosed()) await second.close();
    }

    // Observe actual BFCache use; a reload is not evidence of a persisted restore.
    const bfcache = () =>
      pageA.evaluate(() => {
        const entry = performance.getEntriesByType(
          "navigation",
        )[0] as PerformanceNavigationTiming & {
          notRestoredReasons?: { reasons?: { reason: string }[] };
        };
        return {
          persisted: sessionStorage.getItem("deployment-bfcache"),
          reasons: (entry.notRestoredReasons?.reasons ?? []).map(
            (item) => item.reason,
          ),
          raw: JSON.stringify(entry.notRestoredReasons ?? null),
        };
      });
    await pageA.bringToFront();
    await pageA.evaluate(() => {
      window.addEventListener("pageshow", (event) =>
        sessionStorage.setItem("deployment-bfcache", String(event.persisted)),
      );
    });
    const quietSession = (await hello(pageA, workerUrl)).snapshot?.identity
      ?.sessionId;
    await pageA.goto("about:blank", { waitUntil: "commit" });
    await pageA.goBack({ waitUntil: "commit" });
    await pageA.bringToFront();
    await pageA.getByTestId("section-home").waitFor({ state: "visible" });
    const quiet = await bfcache();
    assert.equal(
      quiet.persisted,
      "true",
      `a quiet round trip must restore from BFCache; not-restored reasons: ${quiet.raw}`,
    );
    const quietHello = await hello(pageA, workerUrl);
    assert.equal(quietHello.snapshot?.status, "unlocked");
    assert.equal(quietHello.snapshot?.identity?.sessionId, quietSession);
    console.log(
      "PASS quiet BFCache round trip restores the unlocked page in the same session",
    );

    await pageA.evaluate(() => sessionStorage.removeItem("deployment-bfcache"));
    await pageA.goto("about:blank", { waitUntil: "commit" });
    await logout(pageB);
    await pageA.goBack({ waitUntil: "commit" });
    await pageA.bringToFront();
    await pageA.getByTestId("profile-option-new").waitFor({ state: "visible" });
    const peerLogout = await bfcache();
    assert.equal(await pageA.getByTestId("created-api-key").count(), 0);
    assert.equal((await hello(pageA, workerUrl)).snapshot?.status, "locked");
    // A cached page that received the peer's logout is evicted by Chromium; either outcome is safe if explained.
    assert.ok(
      peerLogout.persisted === "true" || peerLogout.reasons.length > 0,
      `history entry neither restored nor explained: ${peerLogout.raw}`,
    );
    console.log(
      peerLogout.persisted === "true"
        ? "PASS actual BFCache restore after peer logout remains locked"
        : `PASS BFCache entry evicted after peer logout (${peerLogout.reasons.join(", ")}); reload recovery locked`,
    );

    // A temporary saved entry stays owner-filtered; its active authorization is shared.
    await saveAndEnter(pageA, a, "Temporary-A", "temporary-password", false);
    await pageB.bringToFront();
    await pageB.goto(`${origin}/login`);
    await pageB.getByTestId("profile-option-new").waitFor({ state: "visible" });
    assert.equal(
      await pageB.getByTestId("profile-option-Temporary-A").count(),
      0,
    );
    await pageB.goto(`${origin}/members`);
    await pageB.getByTestId(`member-${a.user}`).waitFor({ state: "visible" });
    assert.equal(
      (await hello(pageB, workerUrl)).snapshot?.profile?.name,
      "Temporary-A",
    );
    const openerPromise = context.waitForEvent("page");
    await pageA.evaluate((url) => {
      window.open(url, "_blank");
    }, `${origin}/login`);
    const opener = await openerPromise;
    watch(opener);
    await opener.bringToFront();
    await opener
      .getByTestId("profile-option-Temporary-A")
      .waitFor({ state: "visible" });
    assert.equal(
      await opener.evaluate(() =>
        sessionStorage.getItem("headscale-ui-tab-id"),
      ),
      await pageA.evaluate(() => sessionStorage.getItem("headscale-ui-tab-id")),
      "opener retains the existing sessionStorage clone semantics",
    );
    await opener.close();
    const independentPromise = context.waitForEvent("page");
    await pageA.evaluate((url) => {
      window.open(url, "_blank", "noopener");
    }, `${origin}/login`);
    const independent = await independentPromise;
    watch(independent);
    await independent.bringToFront();
    await independent
      .getByTestId("profile-option-new")
      .waitFor({ state: "visible" });
    assert.equal(
      await independent.getByTestId("profile-option-Temporary-A").count(),
      0,
    );
    assert.notEqual(
      await independent.evaluate(() =>
        sessionStorage.getItem("headscale-ui-tab-id"),
      ),
      await pageA.evaluate(() => sessionStorage.getItem("headscale-ui-tab-id")),
    );
    await independent.close();
    await logout(pageB);
    await pageA.getByTestId("profile-option-new").waitFor({ state: "visible" });
    assert.equal(
      await pageB.getByTestId("profile-option-Temporary-A").count(),
      0,
    );
    await pageA
      .getByTestId("profile-option-Temporary-A")
      .waitFor({ state: "visible" });
    console.log(
      "PASS temporary owner list, opener inheritance, independent-page isolation, and shared authorization",
    );

    await unlock(pageA, "Server-B", "password-B");
    await pageB.goto(`${origin}/members`);
    await members(pageA, b);
    const beforeTermination = await hello(pageA, workerUrl);
    await evaluateSharedWorker(
      pageA,
      workerUrl,
      "setTimeout(() => self.close(), 20); true",
    );
    await waitUntil(async () => {
      try {
        await evaluateSharedWorker(pageA, workerUrl, "true");
        return false;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "SharedWorker target missing"
        )
          return true;
        throw error;
      }
    });
    // A command observes the silent close through the bounded reply deadline.
    await pageA.getByTestId("refresh-users").click();
    await pageA
      .getByTestId("error-screen")
      .waitFor({ state: "visible", timeout: 25000 });
    assert.equal(await pageA.getByTestId("section-home").count(), 0);
    await pageA.getByTestId("error-reload").click();
    await pageA.getByTestId("profile-option-new").waitFor({ state: "visible" });
    const restarted = await hello(pageA, workerUrl);
    assert.notEqual(restarted.workerId, beforeTermination.workerId);
    assert.equal(
      restarted.snapshot?.status,
      "locked",
      "new Worker cannot restore decrypted credentials",
    );
    await pageB.bringToFront();
    await pageB.reload();
    await pageB.getByTestId("profile-option-new").waitFor({ state: "visible" });
    assert.equal((await hello(pageB, workerUrl)).workerId, restarted.workerId);
    console.log(
      "PASS silent Worker termination, bounded failure, and locked recovery",
    );

    // Worker death with a committed write held: bounded failure, no key, no replay.
    await unlock(pageA, "Server-B", "password-B");
    b.network.clearOperationCalls();
    const dying = b.network.intercept({
      method: "POST",
      pathPattern: "^/api/v1/apikey$",
    });
    try {
      await openApiKeySettings(pageA);
      const beforeDeath = await hello(pageA, workerUrl);
      await pageA.getByTestId("create-api-key-confirm").click();
      await waitUntil(async () => dying.getSnapshot().captured);
      await evaluateSharedWorker(
        pageA,
        workerUrl,
        "setTimeout(() => self.close(), 20); true",
      );
      await pageA
        .getByTestId("error-screen")
        .waitFor({ state: "visible", timeout: 25000 });
      await dying.release();
      assert.equal(
        dying.getSnapshot().upstreamRequests,
        1,
        "Worker death: one upstream write",
      );
      assert.equal(apiKeyCreates(), 1, "Worker death: one write at the proxy");
      await assertNoKeyAnywhere();
      await pageA.getByTestId("error-reload").click();
      await pageA
        .getByTestId("profile-option-new")
        .waitFor({ state: "visible" });
      const afterDeath = await hello(pageA, workerUrl);
      assert.notEqual(afterDeath.workerId, beforeDeath.workerId);
      assert.equal(afterDeath.snapshot?.status, "locked");
      await Bun.sleep(1500);
      assert.equal(
        apiKeyCreates(),
        1,
        "Worker death: a lost write is never replayed",
      );
      console.log(
        "PASS Worker death with a held write surfaced error-screen without key or replay",
      );
    } finally {
      await dying.release();
    }

    assert.deepEqual(
      errors,
      [],
      "production pages have no unhandled browser errors",
    );
  } finally {
    if (frozen)
      await cdp.send("Page.setWebLifecycleState", { state: "active" });
    await cdp.detach();
    await context.close();
    await a.network.reset();
    await b.network.reset();
  }
}
