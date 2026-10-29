import {
  createFormHook,
  createFormHookContexts,
  revalidateLogic,
  useStore,
} from "@tanstack/react-form";
import { LoaderCircle } from "lucide-react";
import { type ComponentProps, type ReactNode, useId } from "react";
import { NativeSelect } from "@/components/app/native-select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

const { fieldContext, formContext, useFieldContext, useFormContext } =
  createFormHookContexts();

type FieldPresentation = {
  label?: ReactNode;
  description?: ReactNode;
  fieldClassName?: string;
  errorId?: string;
};

function errorText(error: unknown): string {
  if (error && typeof error === "object" && "message" in error)
    return String(error.message);
  return String(error);
}

function useFieldPresentation<T>(
  id: string | undefined,
  describedBy: string | undefined,
  description: ReactNode,
  errorId?: string,
) {
  const generatedId = useId();
  const field = useFieldContext<T>();
  const isSubmitting = useStore(
    field.form.store,
    (state) => state.isSubmitting,
  );
  const controlId = id ?? generatedId;
  const messageId = errorId ?? `${controlId}-error`;
  const errors = field.state.meta.isTouched ? field.state.meta.errors : [];
  const error = [...new Set(errors.map(errorText))].join(" ");
  return {
    field,
    id: controlId,
    error,
    errorId: messageId,
    isSubmitting,
    describedBy:
      [
        describedBy,
        description && `${controlId}-description`,
        error && messageId,
      ]
        .filter(Boolean)
        .join(" ") || undefined,
  };
}

function FieldMessage({
  id,
  errorId,
  error,
  description,
}: {
  id: string;
  errorId: string;
  error: string;
  description?: ReactNode;
}) {
  return (
    <>
      {description ? (
        <div id={`${id}-description`} className="text-xs text-muted-foreground">
          {description}
        </div>
      ) : null}
      {error ? (
        <p
          id={errorId}
          data-testid={errorId}
          className="text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
    </>
  );
}

type TextFieldProps = FieldPresentation &
  Omit<
    ComponentProps<typeof Input>,
    "name" | "value" | "defaultValue" | "onChange" | "onBlur"
  > & {
    // 既有密码保留原文，由 Worker 在解密边界尝试兼容候选。
    trimOnBlur?: boolean;
  };

function TextField({
  label,
  description,
  fieldClassName,
  errorId,
  trimOnBlur = true,
  id,
  "aria-describedby": describedBy,
  ...props
}: TextFieldProps) {
  const control = useFieldPresentation<string>(
    id,
    describedBy,
    description,
    errorId,
  );
  return (
    <div className={cn("grid min-w-0 gap-1.5", fieldClassName)}>
      {label ? <Label htmlFor={control.id}>{label}</Label> : null}
      <Input
        {...props}
        id={control.id}
        name={control.field.name}
        value={control.field.state.value}
        aria-invalid={Boolean(control.error) || props["aria-invalid"]}
        aria-describedby={control.describedBy}
        readOnly={props.readOnly || control.isSubmitting}
        onChange={(event) => control.field.handleChange(event.target.value)}
        onBlur={(event) => {
          if (
            trimOnBlur &&
            !event.currentTarget.readOnly &&
            !event.currentTarget.disabled &&
            !control.field.form.state.isSubmitting
          ) {
            const normalized = control.field.state.value.trim();
            if (normalized !== control.field.state.value)
              control.field.handleChange(normalized);
          }
          control.field.handleBlur();
        }}
      />
      <FieldMessage
        id={control.id}
        errorId={control.errorId}
        error={control.error}
        description={description}
      />
    </div>
  );
}

type SelectFieldProps = FieldPresentation &
  Omit<
    ComponentProps<typeof NativeSelect>,
    "name" | "value" | "defaultValue" | "onChange" | "onBlur"
  >;

function SelectField({
  label,
  description,
  fieldClassName,
  errorId,
  id,
  "aria-describedby": describedBy,
  ...props
}: SelectFieldProps) {
  const control = useFieldPresentation<string>(
    id,
    describedBy,
    description,
    errorId,
  );
  return (
    <div className={cn("grid min-w-0 gap-1.5", fieldClassName)}>
      {label ? <Label htmlFor={control.id}>{label}</Label> : null}
      <NativeSelect
        {...props}
        disabled={props.disabled || control.isSubmitting}
        id={control.id}
        name={control.field.name}
        value={control.field.state.value}
        aria-invalid={Boolean(control.error) || props["aria-invalid"]}
        aria-describedby={control.describedBy}
        onChange={(event) => control.field.handleChange(event.target.value)}
        onBlur={control.field.handleBlur}
      />
      <FieldMessage
        id={control.id}
        errorId={control.errorId}
        error={control.error}
        description={description}
      />
    </div>
  );
}

type CheckboxFieldProps = FieldPresentation &
  Omit<
    ComponentProps<typeof Checkbox>,
    "name" | "checked" | "defaultChecked" | "onCheckedChange" | "onBlur"
  >;

function CheckboxField({
  label,
  description,
  fieldClassName,
  errorId,
  id,
  "aria-describedby": describedBy,
  ...props
}: CheckboxFieldProps) {
  const control = useFieldPresentation<boolean>(
    id,
    describedBy,
    description,
    errorId,
  );
  return (
    <div className={cn("grid min-w-0 gap-1.5", fieldClassName)}>
      <div className="flex items-center gap-2">
        <Checkbox
          {...props}
          disabled={props.disabled || control.isSubmitting}
          id={control.id}
          name={control.field.name}
          checked={control.field.state.value}
          aria-invalid={Boolean(control.error) || props["aria-invalid"]}
          aria-describedby={control.describedBy}
          onCheckedChange={(checked) => control.field.handleChange(checked)}
          onBlur={control.field.handleBlur}
        />
        {label ? <Label htmlFor={control.id}>{label}</Label> : null}
      </div>
      <FieldMessage
        id={control.id}
        errorId={control.errorId}
        error={control.error}
        description={description}
      />
    </div>
  );
}

export async function submitForm<T>(
  form: {
    state: { isSubmitting: boolean };
    handleSubmit: (meta?: T) => Promise<void>;
  },
  meta?: T,
) {
  // React 提交按钮禁用状态前，可能已经收到第二次提交事件。
  if (form.state.isSubmitting) return;
  await form.handleSubmit(meta);
}

function Form({
  children,
  ...props
}: Omit<ComponentProps<"form">, "onSubmit">) {
  const form = useFormContext();
  return (
    <form
      {...props}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const element = event.currentTarget;
        void submitForm(form).then(() => {
          if (!form.state.isValid) {
            requestAnimationFrame(() =>
              element
                .querySelector<HTMLElement>('[aria-invalid="true"]')
                ?.focus(),
            );
          }
        });
      }}
    >
      {children}
    </form>
  );
}

function SubmitButton({
  children,
  disabled,
  busy = false,
  ...props
}: ComponentProps<typeof Button> & { busy?: boolean }) {
  const form = useFormContext();
  return (
    <form.Subscribe
      selector={(state) => [state.canSubmit, state.isSubmitting] as const}
    >
      {([canSubmit, isSubmitting]) => (
        <Button
          type="submit"
          {...props}
          disabled={disabled || !canSubmit || isSubmitting || busy}
          aria-busy={isSubmitting || busy}
        >
          {isSubmitting || busy ? (
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : null}
          {children}
        </Button>
      )}
    </form.Subscribe>
  );
}

const appForm = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: { TextField, SelectField, CheckboxField },
  formComponents: { Form, SubmitButton },
});

export const useAppForm: typeof appForm.useAppForm = (options) =>
  appForm.useAppForm({ validationLogic: revalidateLogic(), ...options });
