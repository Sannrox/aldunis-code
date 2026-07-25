import React, { type ReactNode } from "react";
import { Select as BaseSelect } from "@base-ui/react/select";

export type SelectOption = { value: string; label: ReactNode };

export type WorkbenchSelectProps = {
  value: string | null;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
};

/**
 * Accessible select built on @base-ui/react.
 * Existing native <select> call sites may keep working; migrate when layout allows.
 */
export function WorkbenchSelect({
  value,
  onValueChange,
  options,
  placeholder = "Select…",
  ariaLabel,
  className = "ui-select",
  disabled,
}: WorkbenchSelectProps) {
  return (
    <BaseSelect.Root
      value={value}
      onValueChange={(next) => {
        if (typeof next === "string") onValueChange(next);
      }}
      disabled={disabled}
    >
      <BaseSelect.Trigger className={`${className}__trigger`} aria-label={ariaLabel}>
        <BaseSelect.Value placeholder={placeholder} />
        <BaseSelect.Icon className={`${className}__icon`}>▾</BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={4}>
          <BaseSelect.Popup className={`${className}__popup`}>
            {options.map((option) => (
              <BaseSelect.Item
                key={option.value}
                value={option.value}
                className={`${className}__item`}
              >
                <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}

export const Select = BaseSelect;
