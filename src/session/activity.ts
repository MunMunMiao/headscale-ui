import type {
  PublicSessionSnapshot,
  SessionIdentity,
  SessionResult,
} from "./types";

export interface SessionActivityBridge {
  getSessionSnapshot(): Readonly<PublicSessionSnapshot> | null;
  touch(
    expected: SessionIdentity,
  ): Promise<SessionResult<PublicSessionSnapshot>>;
  check(): Promise<SessionResult<PublicSessionSnapshot>>;
  suspend(): void;
  resume(): Promise<SessionResult<PublicSessionSnapshot>>;
  dispose(): void;
}

type EventSource = Pick<
  EventTarget,
  "addEventListener" | "removeEventListener"
>;
export interface SessionActivitySource {
  document: EventSource & { readonly visibilityState: DocumentVisibilityState };
  window: EventSource;
  now(): number;
}

export function attachSessionActivity(
  source: SessionActivitySource,
  bridge: SessionActivityBridge,
): () => void {
  let disposed = false;
  let suspended = source.document.visibilityState !== "visible";
  let generation = 0;
  let lastSent = -Infinity;
  let lastIdentity: SessionIdentity | null = null;
  const options = { capture: true, passive: true };

  function activity(event: Event) {
    if (
      !event.isTrusted ||
      suspended ||
      source.document.visibilityState !== "visible"
    )
      return;
    const snapshot = bridge.getSessionSnapshot();
    if (snapshot?.status !== "unlocked" || !snapshot.identity) return;
    const now = source.now();
    const sameSession =
      lastIdentity?.workerId === snapshot.identity.workerId &&
      lastIdentity?.sessionId === snapshot.identity.sessionId;
    if (sameSession && now - lastSent < 1000) return;
    lastSent = now;
    lastIdentity = snapshot.identity;
    void bridge.touch(snapshot.identity);
  }

  function suspend() {
    ++generation;
    suspended = true;
    bridge.suspend();
  }

  async function resume() {
    if (source.document.visibilityState !== "visible") return;
    const current = ++generation;
    suspended = true;
    const result = await bridge.resume();
    if (
      !disposed &&
      current === generation &&
      source.document.visibilityState === "visible"
    )
      suspended = !result.ok;
  }

  function visibility() {
    if (source.document.visibilityState === "visible") void resume();
    else suspend();
  }

  function pagehide(event: Event) {
    suspend();
    if (!(event as PageTransitionEvent).persisted) {
      cleanup();
      bridge.dispose();
    }
  }

  const events: [EventSource, string, EventListener][] = [
    ...["pointerdown", "keydown", "wheel", "input"].map(
      (type): [EventSource, string, EventListener] => [
        source.document,
        type,
        activity,
      ],
    ),
    [source.document, "visibilitychange", visibility],
    [source.document, "freeze", suspend],
    [source.document, "resume", resume],
    [source.window, "focus", resume],
    [source.window, "pageshow", resume],
    [source.window, "pagehide", pagehide],
  ];
  for (const [target, type, listener] of events)
    target.addEventListener(type, listener, options);
  if (suspended) bridge.suspend();
  function cleanup() {
    if (disposed) return;
    disposed = true;
    ++generation;
    for (const [target, type, listener] of events)
      target.removeEventListener(type, listener, options);
  }
  return cleanup;
}
