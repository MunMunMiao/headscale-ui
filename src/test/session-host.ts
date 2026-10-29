import { DB_VERSION } from "@/lib/idb";
import { createSessionBridge, type SessionBridge } from "@/session/bridge";
import { createSessionHost } from "@/session/host";

export async function createSessionHarness() {
  const host = await createSessionHost("test-build");
  const pages: SessionBridge[] = [];
  const channels: MessageChannel[] = [];
  return {
    async openPage(owner: string = crypto.randomUUID()) {
      const bridge = createSessionBridge({
        openPort: () => {
          const channel = new MessageChannel();
          channels.push(channel);
          host.connect(channel.port2);
          return channel.port1;
        },
        ownerTabId: () => owner,
        buildId: "test-build",
        storageVersion: DB_VERSION,
      });
      pages.push(bridge);
      const ready = await bridge.connect();
      if (!ready.ok) throw new Error(ready.error.kind);
      const profiles = await bridge.listProfiles();
      if (!profiles.ok) throw new Error(profiles.error.kind);
      return { bridge, profiles: profiles.value };
    },
    async dispose() {
      for (const bridge of pages) bridge.dispose();
      for (const channel of channels) {
        channel.port1.close();
        channel.port2.close();
      }
      await host.dispose();
    },
  };
}
