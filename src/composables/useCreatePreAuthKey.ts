import {
  type RouterHistory,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { type RefObject, useEffect, useRef, useState } from "react";
import type {
  AuthKeyDialogDraft,
  AuthKeyDialogPayload,
} from "@/components/create-auth-key-dialog";
import { i18n } from "@/i18n";
import { productDescriptors } from "@/i18n/descriptors";
import { useSession, useStore } from "./session-context";
import type { TagReturnRecord } from "./tag-lifecycle-state";
import { useMutation } from "./useMutation";

/** A failed or unknown creation never destroys the previous one-time secret. */
export function useCreatePreAuthKey() {
  const session = useSession();
  const { mutateDetailed } = useMutation();
  const preparing = useRef(false);
  return async (payload: AuthKeyDialogPayload) => {
    const { tagLifecycle, snapshot, feedback, drafts } = session;
    const scope = tagLifecycle.captureScope();
    if (
      preparing.current ||
      feedback.isActionPending("create-invite") ||
      !drafts.isCurrent() ||
      !tagLifecycle.isCurrent(scope)
    )
      return false;
    const selectedUser = snapshot
      .getSnapshot()
      .snapshot.users.find((user) => user.id === payload.user);
    preparing.current = true;
    feedback.setActionOutcome("create-invite", {
      status: "not-dispatched",
      refresh: "not-requested",
    });
    try {
      const fresh = await snapshot.refreshSegments(["identity"]);
      if (!tagLifecycle.isCurrent(scope) || !drafts.isCurrent()) return false;
      const current = snapshot.getSnapshot().snapshot;
      if (
        !fresh ||
        (payload.user &&
          !current.users.some(
            (user) =>
              user.id === payload.user &&
              (!selectedUser || user.name === selectedUser.name),
          ))
      ) {
        const readFailure = fresh
          ? productDescriptors.inviteUserUnavailable
          : productDescriptors.inviteCreateReadFailed;
        feedback.setState((state) => ({
          actionErrors: {
            ...state.actionErrors,
            "create-invite": { message: i18n._(readFailure) },
          },
        }));
        feedback
          .beginNotification({
            isCurrent: () =>
              tagLifecycle.isCurrent(scope) && drafts.isCurrent(),
          })
          .publish({
            tone: "error",
            title: fresh
              ? "product.inviteUserUnavailable"
              : "product.inviteCreateReadFailed",
          });
        return false;
      }
      const created = await mutateDetailed("create-invite", {
        endpoint: "createPreAuthKey",
        input: payload,
      });
      const state = snapshot.getSnapshot();
      // The key inventory is the identity segment; an unrelated fabric or policy failure
      // must not be reported as an inventory read failure.
      const identityReadFailed =
        state.segmentStatus.identity === "error" ||
        Boolean(state.refreshErrors.identity);
      if (
        tagLifecycle.isCurrent(scope) &&
        drafts.isCurrent() &&
        created.outcome.status === "confirmed" &&
        identityReadFailed
      ) {
        feedback
          .beginNotification({
            isCurrent: () =>
              tagLifecycle.isCurrent(scope) && drafts.isCurrent(),
          })
          .publish({
            tone: "warning",
            title: "product.inviteCreateConfirmedRefreshFailed",
          });
      }
      if (!created.ok) return false;
      session.deviceSetup.setState({
        lastCreatedInvite: created.result.preAuthKey.key,
        revealCreatedInvite: true,
      });
      return true;
    } finally {
      preparing.current = false;
    }
  };
}

type InviteSource = "invite" | "member-invite";
type InviteReturn = Extract<TagReturnRecord, { source: InviteSource }>;

/** Only the two invitation dialogs use this adapter; the single return slot belongs to the session. */
export function useInviteTagReturn(
  source: InviteSource,
  onRestore: (record: InviteReturn) => void,
  sourceContext: RefObject<number>,
) {
  const session = useSession();
  const navigate = useNavigate();
  const history: RouterHistory = useRouter().history;
  const { returnTo } = useStore(session.tagLifecycle);
  const [restoring, setRestoring] = useState(false);
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [newerEdit, setNewerEdit] = useState(false);
  const [retry, setRetry] = useState(0);
  const restore = useRef(onRestore);
  restore.current = onRestore;
  const editVersion = useRef(0);
  const restoration = useRef<{ id: string; generation: number } | null>(null);
  const navigation = useRef({
    origin: history.location.pathname,
    generation: 0,
  });
  const departingReturn = useRef<{
    id: string;
    origin: string;
    leftOrigin: boolean;
  } | null>(null);
  const id = returnTo?.source === source ? returnTo.id : null;

  // History events preserve a rapid out-and-back even when React commits only the final URL.
  useEffect(
    () =>
      history.subscribe(({ location }) => {
        ++navigation.current.generation;
        const departure = departingReturn.current;
        if (departure) {
          if (location.pathname !== departure.origin)
            departure.leftOrigin = true;
          else if (departure.leftOrigin) departingReturn.current = null;
        }
        // Navigation restarts the read, never the original user-edit baseline.
        if (restoration.current) setRetry((value) => value + 1);
      }),
    [history],
  );

  // A new return scope or explicit retry must cancel the old continuation and restart its reads.
  useEffect(() => {
    if (!id) {
      departingReturn.current = null;
      restoration.current = null;
      setRestoring(false);
      setRestoreFailed(false);
      setNewerEdit(false);
      return;
    }
    if (restoration.current?.id !== id)
      restoration.current = { id, generation: sourceContext.current };
    if (
      departingReturn.current?.id === id ||
      history.location.pathname !== navigation.current.origin
    ) {
      setRestoring(false);
      setRestoreFailed(false);
      setNewerEdit(false);
      return;
    }
    const generation = restoration.current.generation;
    setRestoreFailed(false);
    if (generation !== sourceContext.current) {
      setRestoring(false);
      setNewerEdit(true);
      return;
    }
    const lifecycle = session.tagLifecycle;
    const scope = lifecycle.captureScope();
    const navigationGeneration = navigation.current.generation;
    if (!lifecycle.requestReturn(id)) return;
    let cancelled = false;
    setRestoring(true);
    setNewerEdit(false);
    void session.snapshot
      .refreshSegments(["identity", "policy"])
      .then((fresh) => {
        if (
          cancelled ||
          navigationGeneration !== navigation.current.generation ||
          history.location.pathname !== navigation.current.origin ||
          !lifecycle.isCurrent(scope)
        )
          return;
        setRestoring(false);
        if (generation !== sourceContext.current) {
          setNewerEdit(true);
          return;
        }
        if (!fresh) {
          setRestoreFailed(true);
          return;
        }
        const record = lifecycle.consumeReturn(id);
        if (record?.source === source) restore.current(record as InviteReturn);
      });
    return () => {
      cancelled = true;
    };
  }, [id, returnTo?.scope, retry, session, source, sourceContext, history]);

  return {
    restoring,
    restoreFailed,
    newerEdit,
    retryRestore() {
      if (!id) return;
      restoration.current = { id, generation: sourceContext.current };
      setRetry((value) => value + 1);
    },
    discardReturn() {
      if (id) session.tagLifecycle.cancelReturn(id);
    },

    manageTags(
      form: AuthKeyDialogDraft,
      tag = "",
      filter?: string,
      memberId?: string,
    ) {
      const record = session.tagLifecycle.saveReturn({
        source,
        managedTag: tag,
        editVersion: ++editVersion.current,
        form,
        filter,
        memberId,
      });
      if (!record) return false;
      departingReturn.current = {
        id: record.id,
        origin: departingReturn.current?.origin ?? navigation.current.origin,
        // Replacing a pending draft at the same URL may not emit another departure event.
        leftOrigin: history.location.pathname !== navigation.current.origin,
      };
      restoration.current = {
        id: record.id,
        generation: sourceContext.current,
      };
      void navigate({ to: "/access", search: tag ? { tag } : {} });
      return true;
    },
  };
}
