import { useLayoutEffect, useRef } from "react";
import { useSession } from "./session-context";

export function useSessionDraft(active: boolean): void {
  const { drafts } = useSession();
  const owner = useRef({});
  useLayoutEffect(() => {
    drafts.setActive(owner.current, active);
  }, [drafts, active]);
  useLayoutEffect(() => {
    const token = owner.current;
    return () => drafts.release(token);
  }, [drafts]);
}
