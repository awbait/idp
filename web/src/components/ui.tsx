import type { ReactNode } from "react";
import { IconChevronDown } from "@tabler/icons-react";
import {
  Button as AriaButton,
  type ButtonProps,
  Select as AriaSelect,
  SelectValue,
  ListBox,
  ListBoxItem,
  Popover,
  Label,
  TextField as AriaTextField,
  Input,
  Checkbox as AriaCheckbox,
  type CheckboxProps,
  TooltipTrigger,
  Tooltip as AriaTooltip,
} from "react-aria-components";

const btnVariants = {
  primary:
    "bg-brand-600 text-on-accent pressed:bg-brand-700 hover:bg-brand-700 border border-transparent",
  secondary:
    "bg-surface text-gray-800 border border-gray-300 hover:bg-gray-50 pressed:bg-gray-100",
  danger: "bg-red-600 text-white hover:bg-red-700 pressed:bg-red-800 border border-transparent",
};

// Hint wraps a focusable trigger (a react-aria Button) with a styled tooltip,
// the same look as the small "i" hints. Note: a tooltip won't open on a truly
// `isDisabled` trigger - keep the button enabled and gate its action instead.
export function Hint({ text, children }: { text: string; children: ReactNode }) {
  return (
    <TooltipTrigger delay={150} closeDelay={0}>
      {children}
      <AriaTooltip
        offset={6}
        className="max-w-xs rounded-md border border-slate-200 bg-surface px-2.5 py-1.5 text-xs text-slate-700 shadow-lg entering:animate-in entering:fade-in entering:zoom-in-95"
      >
        {text}
      </AriaTooltip>
    </TooltipTrigger>
  );
}

export function Button({
  variant = "secondary",
  className = "",
  ...props
}: ButtonProps & { variant?: keyof typeof btnVariants }) {
  return (
    <AriaButton
      {...props}
      className={`inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50 ${btnVariants[variant]} ${className}`}
    />
  );
}

export function TextField({
  label,
  description,
  value,
  onChange,
  errorText,
  onBlur,
  hideLabel,
  ...rest
}: {
  label: string;
  description?: string;
  value: string;
  onChange: (v: string) => void;
  errorText?: string;
  onBlur?: () => void;
  // Render without a visible label (label becomes the aria-label). Used for
  // array rows where the field's meaning comes from the surrounding list.
  hideLabel?: boolean;
  isRequired?: boolean;
  isDisabled?: boolean;
  type?: string;
  placeholder?: string;
}) {
  const invalid = !!errorText;
  return (
    <AriaTextField
      value={value}
      onChange={onChange}
      isRequired={rest.isRequired}
      isDisabled={rest.isDisabled}
      isInvalid={invalid}
      aria-label={hideLabel ? label : undefined}
      className="flex flex-col gap-1"
    >
      {!hideLabel && (
        <Label className="text-sm font-medium text-gray-700">
          {label}
          {rest.isRequired && <span className="text-red-500"> *</span>}
        </Label>
      )}
      <Input
        type={rest.type}
        placeholder={rest.placeholder}
        onBlur={onBlur}
        className={`rounded-md border px-2 py-1.5 text-sm outline-none focus:ring-1 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500 ${
          invalid
            ? "border-red-500 focus:border-red-500 focus:ring-red-500"
            : "border-gray-300 focus:border-brand-500 focus:ring-brand-500"
        }`}
      />
      {errorText ? (
        <span className="text-xs text-red-600">{errorText}</span>
      ) : (
        description && <span className="text-xs text-gray-500">{description}</span>
      )}
    </AriaTextField>
  );
}

export function Checkbox({
  label,
  ...props
}: CheckboxProps & { label: string }) {
  return (
    <AriaCheckbox {...props} className="flex items-center gap-2 text-sm text-gray-700">
      {({ isSelected }) => (
        <>
          <span
            className={`flex h-4 w-4 items-center justify-center rounded border ${
              isSelected ? "border-brand-600 bg-brand-600" : "border-gray-300"
            }`}
          >
            {isSelected && (
              <svg viewBox="0 0 18 18" className="h-3 w-3 fill-none stroke-on-accent stroke-[3]">
                <polyline points="1 9 7 14 15 4" />
              </svg>
            )}
          </span>
          {label}
          {props.isRequired && <span className="text-red-500"> *</span>}
        </>
      )}
    </AriaCheckbox>
  );
}

export function Select<T extends string>({
  label,
  description,
  selectedKey,
  onSelectionChange,
  options,
  isRequired,
  isDisabled,
  errorText,
  hideLabel,
  placeholder = "Выберите…",
}: {
  label: string;
  description?: string;
  selectedKey: T | null;
  onSelectionChange: (key: T) => void;
  options: { id: T; label: string }[];
  isRequired?: boolean;
  isDisabled?: boolean;
  errorText?: string;
  // Render without a visible label (label becomes the aria-label).
  hideLabel?: boolean;
  // Shown by SelectValue when nothing is selected — defaults to a RU placeholder
  // instead of React Aria's built-in English "Select an item".
  placeholder?: string;
}) {
  const invalid = !!errorText;
  return (
    <AriaSelect
      selectedKey={selectedKey}
      onSelectionChange={(k) => onSelectionChange(k as T)}
      isRequired={isRequired}
      isDisabled={isDisabled}
      isInvalid={invalid}
      placeholder={placeholder}
      aria-label={hideLabel ? label : undefined}
      className="flex flex-col gap-1"
    >
      {!hideLabel && (
        <Label className="text-sm font-medium text-gray-700">
          {label}
          {isRequired && <span className="text-red-500"> *</span>}
        </Label>
      )}
      <AriaButton
        className={`flex items-center justify-between rounded-md border px-2 py-1.5 text-sm outline-none disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500 ${
          invalid ? "border-red-500" : "border-gray-300 focus:border-brand-500"
        }`}
      >
        <SelectValue />
        <IconChevronDown size={16} className="text-gray-400" aria-hidden />
      </AriaButton>
      {errorText ? (
        <span className="text-xs text-red-600">{errorText}</span>
      ) : (
        description && <span className="text-xs text-gray-500">{description}</span>
      )}
      <Popover className="min-w-[var(--trigger-width)] rounded-md border border-gray-200 bg-surface shadow-lg">
        <ListBox className="max-h-60 overflow-auto p-1 outline-none">
          {options.map((o) => (
            <ListBoxItem
              key={o.id}
              id={o.id}
              className="cursor-pointer rounded px-2 py-1 text-sm outline-none focus:bg-brand-50 selected:bg-brand-100"
            >
              {o.label}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-gray-200 bg-surface p-4 shadow-sm ${className}`}>
      {children}
    </div>
  );
}

// Chip, единый стиль бейджей-метаданных в шапках (категория, владелец, версия…).
// Цвета задаёт className: фон + текст (например bg-slate-100 text-slate-600),
// внутри удобно префиксовать подпись приглушённым <span> (text-slate-400).
export function Chip({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${className}`}
    >
      {children}
    </span>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return <div className="p-6 text-sm text-gray-500">{label}</div>;
}

export function ErrorBox({ error }: { error: Error }) {
  return (
    <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
      {error.message}
    </div>
  );
}
