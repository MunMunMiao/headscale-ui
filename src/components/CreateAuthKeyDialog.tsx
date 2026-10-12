import { KeyRound, LoaderCircle } from "lucide-react";
import { type ComponentProps, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { useProductCopy } from "@/composables/useProductCopy";
import { useHeadscaleI18n } from "@/i18n";
import { parseList } from "@/utils/strings";
import type {
  AuthKeyDialogDefaults,
  AuthKeyDialogLabels,
  AuthKeyDialogPayload,
  AuthKeyDialogUserOption,
} from "./create-auth-key-dialog";
import {
  AUTH_KEY_EXPIRY_DAYS,
  dateTimeLocalToIso,
  defaultExpirationLocal,
  isFutureExpiration,
} from "./create-auth-key-dialog";
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
  /** Where focus returns on close; `false` leaves focus where the caller moved it. */
  finalFocus?: ComponentProps<typeof DialogContent>["finalFocus"];
  onSubmit: (payload: AuthKeyDialogPayload) => void;
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
  finalFocus,
  onSubmit,
}: CreateAuthKeyDialogProps) {
  const { locale } = useHeadscaleI18n();
  const { copy } = useProductCopy();
  const [ownerOptions, setOwnerOptions] = useState(users);
  useEffect(() => {
    if (!paused) setOwnerOptions(users);
  }, [paused, users]);
  const [form, setForm] = useState({
    user: "",
    reusable: true,
    ephemeral: false,
    expirationLocal: "",
    aclTags: "",
  });
  const [expirationInvalid, setExpirationInvalid] = useState(false);
  const [tagsRequired, setTagsRequired] = useState(false);
  const tagsInput = useRef<HTMLInputElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (paused) return;
    const resolveUser = () =>
      ownerOptions.some((user) => user.id === defaults.user)
        ? defaults.user
        : (ownerOptions[0]?.id ?? "");
    if (open && !wasOpen.current) {
      setForm({
        user: resolveUser(),
        reusable: defaults.reusable,
        ephemeral: defaults.ephemeral,
        expirationLocal: defaultExpirationLocal(expirationDays),
        aclTags: defaults.aclTags,
      });
      setExpirationInvalid(false);
      setTagsRequired(false);
    } else if (open) {
      setForm((current) =>
        current.user === "" || ownerOptions.some((user) => user.id === current.user)
          ? current
          : { ...current, user: resolveUser() },
      );
    }
    wasOpen.current = open;
  }, [open, ownerOptions, defaults, paused, expirationDays]);
  function closeDialog() {
    onOpenChange(false);
  }
  function submitForm() {
    const expirationValid = isFutureExpiration(form.expirationLocal);
    const ownerlessWithoutTags = form.user === "" && parseList(form.aclTags).length === 0;
    if (!expirationValid || ownerlessWithoutTags) {
      setExpirationInvalid(!expirationValid);
      setTagsRequired(ownerlessWithoutTags);
      if (expirationValid) tagsInput.current?.focus();
      return;
    }
    onSubmit({
      user: form.user || undefined,
      reusable: form.reusable,
      ephemeral: form.ephemeral,
      expiration: dateTimeLocalToIso(form.expirationLocal),
      aclTags: parseList(form.aclTags),
    });
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="invite-create-dialog"
        className="sm:max-w-xl"
        finalFocus={finalFocus}
      >
        <DialogHeader>
          <DialogTitle>{labels.title}</DialogTitle>
          <DialogDescription>{labels.description}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          data-testid="invite-form"
          onSubmit={(event) => {
            event.preventDefault();
            submitForm();
          }}
        >
          <div className="grid gap-3">
            <div>
              <Label htmlFor="invite-user">{labels.owner}</Label>
              <NativeSelect
                id="invite-user"
                value={form.user}
                onChange={(event) => {
                  setTagsRequired(false);
                  setForm((current) => ({ ...current, user: event.target.value }));
                }}
                data-testid="invite-user"
                className="mt-2"
                disabled={isSubmitting}
              >
                {ownerOptions.map((user) => (
                  <NativeSelectOption key={user.id} value={user.id}>
                    {user.label}
                  </NativeSelectOption>
                ))}
                <NativeSelectOption value="">{copy.inviteNoOwner}</NativeSelectOption>
              </NativeSelect>
            </div>
            <div>
              <Label htmlFor="invite-expiration">{labels.expiration}</Label>
              <DateTimePicker
                id="invite-expiration"
                value={form.expirationLocal}
                onValueChange={(value) => {
                  setExpirationInvalid(false);
                  setForm((current) => ({ ...current, expirationLocal: value }));
                }}
                error={expirationInvalid ? copy.expirationMustBeFuture : undefined}
                locale={locale}
                placeholder={copy.dateTimePlaceholder}
                timeLabel={labels.time}
                hourLabel={labels.hour}
                minuteLabel={labels.minute}
                testId="invite-expiration"
                className="mt-2"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="invite-tags">{labels.aclTags}</Label>
            <Input
              id="invite-tags"
              value={form.aclTags}
              ref={tagsInput}
              onChange={(event) => {
                setTagsRequired(false);
                setForm((current) => ({ ...current, aclTags: event.target.value }));
              }}
              data-testid="invite-tags"
              className="mt-2"
              placeholder="tag:server"
              disabled={isSubmitting}
              aria-invalid={tagsRequired ? true : undefined}
              aria-describedby={tagsRequired ? "invite-tags-error" : undefined}
            />
            {tagsRequired && (
              <p
                id="invite-tags-error"
                data-testid="invite-tags-error"
                className="mt-2 text-sm text-destructive"
              >
                {copy.inviteTagsRequired}
              </p>
            )}
          </div>
          <div className="grid gap-2">
            <div className="flex min-h-9 items-center gap-2">
              <Checkbox
                id="invite-reusable"
                checked={form.reusable}
                onCheckedChange={(value) => setForm((current) => ({ ...current, reusable: value }))}
                data-testid="invite-reusable"
                disabled={isSubmitting}
              />
              <Label htmlFor="invite-reusable" className="font-normal">
                {labels.reusable}
              </Label>
            </div>
            <div className="flex min-h-9 items-center gap-2">
              <Checkbox
                id="invite-ephemeral"
                checked={form.ephemeral}
                onCheckedChange={(value) =>
                  setForm((current) => ({ ...current, ephemeral: value }))
                }
                data-testid="invite-ephemeral"
                disabled={isSubmitting}
              />
              <Label htmlFor="invite-ephemeral" className="font-normal">
                {labels.ephemeral}
              </Label>
            </div>
          </div>
          {error && (
            <p
              role="alert"
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
              disabled={isSubmitting}
              onClick={closeDialog}
            >
              {labels.cancel}
            </Button>
            <Button type="submit" data-testid="create-invite" disabled={isSubmitting}>
              {isSubmitting ? (
                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <KeyRound className="h-4 w-4" aria-hidden="true" />
              )}
              {labels.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
