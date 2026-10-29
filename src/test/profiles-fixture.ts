import { createActionFeedbackStore } from "@/composables/useActionFeedback";
import { createProfilesStore, newProfileId } from "@/composables/useProfiles";
import { DB_VERSION } from "@/lib/idb";
import { createSessionBridge } from "@/session/bridge";
import { createSessionHost } from "@/session/host";
import { createSessionPorts } from "@/test/session-ports";
import { startSnapshotServer } from "@/test-utils/headscale.test";

export async function profilesFixture(
  cleanup: (() => void | Promise<void>)[],
  handle?: (
    request: Request,
    forward: () => Promise<Response>,
  ) => Response | Promise<Response>,
) {
  const host = await createSessionHost("profiles-test");
  cleanup.push(() => host.dispose());
  const server = startSnapshotServer();
  cleanup.push(server.stop);
  const proxy = handle
    ? Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          return handle(request, () =>
            fetch(`${server.baseUrl}${new URL(request.url).pathname}`, {
              headers: request.headers,
              signal: request.signal,
            }),
          );
        },
      })
    : null;
  if (proxy) cleanup.push(() => proxy.stop(true));
  async function peer(ownerTabId: string) {
    const channels: ReturnType<typeof createSessionPorts>[] = [];
    const bridge = createSessionBridge({
      openPort() {
        const channel = createSessionPorts();
        channels.push(channel);
        host.connect(channel.worker);
        return channel.page;
      },
      ownerTabId: () => ownerTabId,
      buildId: "profiles-test",
      storageVersion: DB_VERSION,
    });
    cleanup.push(() => {
      bridge.dispose();
      for (const channel of channels) channel.close();
    });
    const connected = await bridge.connect();
    if (!connected.ok) throw new Error("Profile bridge unavailable");
    const list = await bridge.listProfiles();
    if (!list.ok) throw new Error("Profile read failed");
    const feedback = createActionFeedbackStore();
    const profiles = createProfilesStore(bridge, feedback, list.value);
    const ports = channels[0];
    if (!ports) throw new Error("Profile bridge did not open a port");
    return { bridge, profiles, feedback, ports };
  }
  const current = await peer("owner-a");
  const form = {
    profileId: newProfileId,
    profileName: "My server",
    baseUrl: proxy?.url.origin ?? server.baseUrl,
    apiKey: "connection-test-key",
    password: "independent-password",
    remember: true,
  };
  return { ...current, server, form, peer };
}
