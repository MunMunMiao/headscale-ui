import { StrictMode, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { AppProviders } from "./AppProviders";
import { createUser } from "./api/commands";
import { useSession, useStore } from "./composables/session-context";
import { useMutation } from "./composables/useMutation";
import { DB_VERSION } from "./lib/idb";
import { clearAllSecureData } from "./lib/secure-storage";
import { hydrateSettings } from "./lib/settings-storage";
import { createSessionBridge } from "./session/bridge";
import { createSessionHost } from "./session/host";
import { createSessionHarness } from "./test/session-host";
import { snapshotFixture } from "./test-utils/headscale.test";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0)) await stop();
  vi.restoreAllMocks();
});
function BusinessRequest() {
  const { mutateWith } = useMutation({ skipRefresh: true });
  const [result, setResult] = useState("");
  return (
    <>
      <button
        type="button"
        onClick={async () => {
          const response = await mutateWith("create-member", createUser({ name: "Ada" }));
          if (response.ok) setResult(response.result.user.name);
        }}
      >
        Create member
      </button>
      <output data-testid="business-result">{result}</output>
    </>
  );
}
function Controls() {
  const session = useSession();
  const client = useStore(session.client);
  const feedback = useStore(session.feedback);
  return (
    <>
      <output data-testid="active-url">{client.settings.baseUrl || "locked"}</output>
      <output data-testid="feedback">{feedback.lastError}</output>
      {["first", "second"].map((name) => (
        <button
          type="button"
          key={name}
          onClick={async () => {
            await session.profiles.loadProfile("__new__");
            session.profiles.setConnectionForm({
              profileName: name,
              baseUrl: `https://${name}.example`,
              apiKey: `fake-${name}-key`,
              password: `${name}-password`,
            });
            await session.profiles.addProfile(true);
          }}
        >
          Choose {name}
        </button>
      ))}
      <button type="button" onClick={() => session.profiles.logout()}>
        Lock
      </button>
      {client.http ? <BusinessRequest /> : null}
    </>
  );
}
test("StrictMode providers project the bridge and send business mutations through the Worker host", async () => {
  await clearAllSecureData();
  await hydrateSettings();
  const fixture = snapshotFixture();
  const writes: { url: string; authorization: string | null; body: unknown }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method === "POST") {
      writes.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      return Response.json({ user: { id: "7", name: url.hostname } });
    }
    const responses: Record<string, unknown> = {
      "/api/v1/health": fixture.health,
      "/version": fixture.version,
      "/api/v1/user": { users: fixture.users },
      "/api/v1/node": { nodes: fixture.nodes },
      "/api/v1/preauthkey": { preAuthKeys: fixture.preAuthKeys },
      "/api/v1/apikey": { apiKeys: fixture.apiKeys },
      "/api/v1/policy": fixture.policy,
    };
    return Response.json(responses[url.pathname]);
  });
  const harness = await createSessionHarness();
  cleanup.push(() => harness.dispose());
  await render(
    <StrictMode>
      <AppProviders initialState={await harness.openPage()}>
        <Controls />
      </AppProviders>
    </StrictMode>,
  );
  await expect.element(page.getByTestId("active-url")).toHaveTextContent("locked");
  for (const name of ["first", "second"]) {
    await page.getByRole("button", { name: `Choose ${name}` }).click();
    await expect
      .element(page.getByTestId("active-url"))
      .toHaveTextContent(`https://${name}.example`);
    await page.getByRole("button", { name: "Create member" }).click();
    await expect.element(page.getByTestId("business-result")).toHaveTextContent(`${name}.example`);
  }
  expect(writes).toEqual(
    ["first", "second"].map((name) => ({
      url: `https://${name}.example/api/v1/user`,
      authorization: `Bearer fake-${name}-key`,
      body: { name: "Ada" },
    })),
  );
  await page.getByRole("button", { name: "Lock", exact: true }).click();
  await expect.element(page.getByTestId("active-url")).toHaveTextContent("locked");
});

test.each(["unavailable", "reload-required", "build-mismatch"] as const)(
  "providers replace business controls with an explicit recovery action after %s",
  async (kind) => {
    await clearAllSecureData();
    await hydrateSettings();
    const host = await createSessionHost("provider-recovery");
    const channels: MessageChannel[] = [];
    let expire: (() => void) | undefined;
    const bridge = createSessionBridge({
      openPort() {
        const channel = new MessageChannel();
        channels.push(channel);
        host.connect(channel.port2);
        return channel.port1;
      },
      ownerTabId: () => "provider-owner",
      buildId: kind === "build-mismatch" ? "newer-page" : "provider-recovery",
      storageVersion: kind === "reload-required" ? DB_VERSION - 1 : DB_VERSION,
      schedule(milliseconds, callback) {
        const timer = setTimeout(callback, milliseconds);
        if (milliseconds === 5_000) expire = callback;
        return () => clearTimeout(timer);
      },
    });
    cleanup.push(async () => {
      bridge.dispose();
      for (const channel of channels) {
        channel.port1.close();
        channel.port2.close();
      }
      await host.dispose();
    });
    await bridge.connect();
    await render(
      <AppProviders initialState={{ bridge, profiles: null }}>
        <button type="button">Business control</button>
      </AppProviders>,
    );
    if (kind === "unavailable") {
      await expect.element(page.getByRole("button", { name: "Business control" })).toBeVisible();
      await host.dispose();
      const checking = bridge.check();
      expect.assert(expire);
      expire();
      expect(await checking).toMatchObject({ ok: false, error: { kind: "unavailable" } });
    }
    await expect.element(page.getByTestId("error-screen")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Business control" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByTestId("error-reload")).toBeEnabled();
    await expect
      .element(page.getByTestId("error-screen"))
      .toMatchTextContent(
        kind === "unavailable"
          ? "shared session is unavailable"
          : "shared session are incompatible",
      );
  },
);
