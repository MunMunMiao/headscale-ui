import { useStore } from "@tanstack/react-form";
import { Link } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { DateTimePicker } from "@/components/app/date-time-picker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/app/dialog";
import { useAppForm } from "@/components/app/form";
import { NativeSelectOption } from "@/components/app/native-select";
import { TagField } from "@/components/TagField";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { MutationOutcome } from "@/composables/tag-lifecycle-state";
import { useProductCopy } from "@/composables/useProductCopy";
import { useHeadscaleI18n } from "@/i18n";
import { isNodeTag, parseNodeTags } from "@/utils/node";
import type {
  AuthKeyDialogDefaults,
  AuthKeyDialogDraft,
  AuthKeyDialogLabels,
  AuthKeyDialogPayload,
  AuthKeyDialogUserOption,
} from "./create-auth-key-dialog";
import {
  AUTH_KEY_EXPIRY_DAYS,
  dateTimeLocalToIso,
  defaultExpirationLocal,
  isFutureExpiration,
  isoToDateTimeLocal,
} from "./create-auth-key-dialog";

const NO_TAGS: readonly string[] = [];

export function CreateKeyOutcomeNotice({
  outcome,
  onVerify,
}: {
  outcome: MutationOutcome | undefined;
  onVerify?: () => void;
}) {
  const { copy } = useProductCopy();
  if (!outcome || !["unknown", "possibly-applied"].includes(outcome.status))
    return null;
  return (
    <section
      className="grid gap-2 rounded-md border p-3 text-sm"
      data-testid="invite-create-unknown"
    >
      <p>{copy.inviteCreateUnknown}</p>
      <Link
        to="/invites"
        onClick={onVerify}
        data-testid="invite-create-verify"
        className="w-fit underline underline-offset-4"
      >
        {copy.invitesTitle}
      </Link>
    </section>
  );
}

export interface CreateAuthKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  users: readonly AuthKeyDialogUserOption[];
  defaults: AuthKeyDialogDefaults;
  labels: AuthKeyDialogLabels;
  isSubmitting: boolean;
  paused: boolean;
  expirationDays?: number;
  error: string;
  restoredDraft?: AuthKeyDialogDraft | null;
  tagOptions?: readonly string[];
  declaredTags?: readonly string[] | null;
  tagReadError?: string;
  onRetryTags?: () => void;
  onManageTags?: (draft: AuthKeyDialogDraft, tag?: string) => void;
  outcome?: ReactNode;
  /** Where focus returns on close; `false` leaves focus where the caller moved it. */
  finalFocus?: ComponentProps<typeof DialogContent>["finalFocus"];
  onSubmit: (payload: AuthKeyDialogPayload) => void | Promise<void>;
}

export default function CreateAuthKeyDialog({
  open,
  onOpenChange,
  users,
  defaults,
  labels,
  isSubmitting,
  paused,
  expirationDays = AUTH_KEY_EXPIRY_DAYS,
  error,
  restoredDraft,
  tagOptions = NO_TAGS,
  declaredTags = null,
  tagReadError,
  onRetryTags,
  onManageTags,
  outcome,
  finalFocus,
  onSubmit,
}: CreateAuthKeyDialogProps) {
  const { locale } = useHeadscaleI18n();
  const { copy } = useProductCopy();
  const [ownerOptions, setOwnerOptions] = useState(users);
  const [tagSearch, setTagSearch] = useState("");
  const selectedUser = useRef<AuthKeyDialogUserOption | null>(null);
  const absoluteExpiration = useRef({ local: "", absolute: "" });
  useEffect(() => {
    if (!paused) setOwnerOptions(users);
  }, [paused, users]);

  function expirationValue(local: string) {
    return local === absoluteExpiration.current.local
      ? absoluteExpiration.current.absolute
      : dateTimeLocalToIso(local.trim());
  }
  function userUnavailable(id: string) {
    if (!id) return false;
    const current = ownerOptions.find((user) => user.id === id);
    return (
      !current ||
      Boolean(
        selectedUser.current?.name &&
        (current.name ?? current.label) !== selectedUser.current.name,
      )
    );
  }
  const form = useAppForm({
    defaultValues: {
      user: "",
      reusable: true,
      ephemeral: false,
      expirationLocal: "",
      aclTags: "",
    },
    validators: {
      onDynamic: ({ value }) => {
        const tags = parseNodeTags(value.aclTags);
        return {
          fields: {
            user: userUnavailable(value.user)
              ? copy.inviteUserUnavailable
              : undefined,
            expirationLocal: isFutureExpiration(
              expirationValue(value.expirationLocal),
            )
              ? undefined
              : copy.expirationMustBeFuture,
            aclTags: !tags.every(isNodeTag)
              ? copy.inviteTagsPrefix
              : !value.user.trim() && tags.length === 0
                ? copy.inviteTagsRequired
                : undefined,
          },
        };
      },
    },
    onSubmit: async ({ value }) => {
      if (isSubmitting || paused) return;
      await onSubmit({
        user: value.user.trim() || undefined,
        reusable: value.reusable,
        ephemeral: value.ephemeral,
        expiration: expirationValue(value.expirationLocal),
        aclTags: parseNodeTags(value.aclTags),
      });
    },
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);
  const hasTags = useStore(
    form.store,
    (state) => parseNodeTags(state.values.aclTags).length > 0,
  );
  const busy = isSubmitting || submitting;
  const disabled = busy || paused;
  const wasOpen = useRef(false);
  useEffect(() => {
    if (paused) return;
    if (open && !wasOpen.current) {
      const local = restoredDraft
        ? isoToDateTimeLocal(restoredDraft.expiration)
        : defaultExpirationLocal(expirationDays);
      absoluteExpiration.current = {
        local,
        absolute: restoredDraft?.expiration ?? dateTimeLocalToIso(local),
      };
      const userId = restoredDraft?.userId ?? defaults.user;
      const option = ownerOptions.find((user) => user.id === userId);
      selectedUser.current = restoredDraft
        ? {
            id: userId,
            name: restoredDraft.userName,
            label: option?.label ?? restoredDraft.userName,
          }
        : (option ?? { id: userId, label: userId });
      setTagSearch(restoredDraft?.tagInput ?? "");
      form.reset(
        {
          user: userId,
          reusable: restoredDraft?.reusable ?? defaults.reusable,
          ephemeral: restoredDraft?.ephemeral ?? defaults.ephemeral,
          expirationLocal: local,
          aclTags: restoredDraft
            ? restoredDraft.tags.join(", ")
            : defaults.aclTags,
        },
        { keepDefaultValues: true },
      );
    }
    wasOpen.current = open;
  }, [
    open,
    ownerOptions,
    defaults,
    paused,
    expirationDays,
    restoredDraft,
    form,
  ]);

  function changeOpen(next: boolean) {
    if (isSubmitting || form.state.isSubmitting) return;
    onOpenChange(next);
  }
  function manageTags(tag?: string) {
    if (disabled || form.state.isSubmitting) return;
    const value = form.state.values;
    onManageTags?.(
      {
        userId: value.user,
        userName:
          selectedUser.current?.name ?? selectedUser.current?.label ?? "",
        tags: parseNodeTags(value.aclTags),
        tagInput: tagSearch,
        reusable: value.reusable,
        ephemeral: value.ephemeral,
        expiration: expirationValue(value.expirationLocal),
        expirationMode: restoredDraft?.expirationMode ?? "custom",
        expiryDays: restoredDraft?.expiryDays ?? String(expirationDays),
      },
      tag,
    );
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        data-testid="invite-create-dialog"
        className="sm:max-w-xl"
        finalFocus={finalFocus}
      >
        <DialogHeader>
          <DialogTitle>{labels.title}</DialogTitle>
          <DialogDescription>{labels.description}</DialogDescription>
        </DialogHeader>
        <form.AppForm>
          <form.Form className="grid gap-3" data-testid="invite-form">
            <div className="grid gap-3">
              <div>
                <form.AppField
                  name="user"
                  listeners={{
                    onChange: ({ value }) => {
                      selectedUser.current =
                        ownerOptions.find((user) => user.id === value) ?? null;
                    },
                  }}
                >
                  {(field) => (
                    <field.SelectField
                      id="invite-user"
                      label={hasTags ? copy.inviteCreatorLabel : labels.owner}
                      data-testid="invite-user"
                      disabled={disabled}
                      aria-describedby={
                        hasTags ? "invite-owner-hint" : undefined
                      }
                    >
                      {field.state.value &&
                        !ownerOptions.some(
                          (user) => user.id === field.state.value,
                        ) && (
                          <NativeSelectOption
                            value={field.state.value}
                            disabled
                          >
                            {selectedUser.current?.label || field.state.value} —{" "}
                            {copy.errorUserNotFound}
                          </NativeSelectOption>
                        )}
                      {ownerOptions.map((user) => (
                        <NativeSelectOption key={user.id} value={user.id}>
                          {user.label}
                        </NativeSelectOption>
                      ))}
                      <NativeSelectOption value="">
                        {copy.inviteNoOwner}
                      </NativeSelectOption>
                    </field.SelectField>
                  )}
                </form.AppField>
                {hasTags && (
                  <p
                    id="invite-owner-hint"
                    data-testid="invite-owner-hint"
                    className="mt-2 text-xs text-muted-foreground"
                  >
                    {copy.taggedKeyCreatorHint}
                  </p>
                )}
              </div>
              <form.Field name="expirationLocal">
                {(field) => (
                  <div>
                    <Label htmlFor="invite-expiration">
                      {labels.expiration}
                    </Label>
                    <DateTimePicker
                      id="invite-expiration"
                      value={field.state.value}
                      onValueChange={field.handleChange}
                      onBlur={field.handleBlur}
                      disabled={disabled}
                      error={
                        field.state.meta.isTouched
                          ? field.state.meta.errors.join(" ")
                          : undefined
                      }
                      locale={locale}
                      placeholder={copy.dateTimePlaceholder}
                      timeLabel={labels.time}
                      hourLabel={labels.hour}
                      minuteLabel={labels.minute}
                      testId="invite-expiration"
                      className="mt-2"
                    />
                  </div>
                )}
              </form.Field>
            </div>
            <form.Field name="aclTags">
              {(field) => (
                <div className="grid gap-2">
                  <Label>{labels.aclTags}</Label>
                  <TagField
                    id="invite-tags"
                    mode="key"
                    value={parseNodeTags(field.state.value)}
                    onChange={(tags) => field.handleChange(tags.join(", "))}
                    search={tagSearch}
                    onSearchChange={setTagSearch}
                    options={tagOptions}
                    declaredTags={declaredTags}
                    disabled={disabled}
                    onBlur={field.handleBlur}
                    error={
                      field.state.meta.isTouched &&
                      field.state.meta.errors.length
                        ? field.state.meta.errors.join(" ")
                        : tagReadError
                    }
                    onRetry={onRetryTags}
                    onManage={onManageTags ? manageTags : undefined}
                  />
                </div>
              )}
            </form.Field>
            <div className="grid gap-2">
              <form.AppField name="reusable">
                {(field) => (
                  <field.CheckboxField
                    id="invite-reusable"
                    label={labels.reusable}
                    fieldClassName="min-h-9"
                    data-testid="invite-reusable"
                    disabled={disabled}
                  />
                )}
              </form.AppField>
              <form.AppField name="ephemeral">
                {(field) => (
                  <field.CheckboxField
                    id="invite-ephemeral"
                    label={labels.ephemeral}
                    fieldClassName="min-h-9"
                    data-testid="invite-ephemeral"
                    disabled={disabled}
                  />
                )}
              </form.AppField>
            </div>
            {outcome}
            {error && (
              <p
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                data-testid="create-invite-error"
              >
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                data-testid="cancel-create-invite"
                disabled={busy}
                onClick={() => changeOpen(false)}
              >
                {labels.cancel}
              </Button>
              <form.SubmitButton
                data-testid="create-invite"
                disabled={paused}
                busy={isSubmitting}
              >
                {!busy ? (
                  <KeyRound className="h-4 w-4" aria-hidden="true" />
                ) : null}
                {labels.submit}
              </form.SubmitButton>
            </DialogFooter>
          </form.Form>
        </form.AppForm>
      </DialogContent>
    </Dialog>
  );
}
