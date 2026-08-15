import React from "react";

export function BranchSuggestionInput({
  id,
  name,
  value,
  options,
  defaultBranch,
  branchCount,
  truncated = false,
  disabled = false,
  initialFocus = false,
  onChange,
}: {
  id: string;
  name?: string;
  value: string;
  options: readonly string[];
  defaultBranch?: string | null;
  branchCount?: number;
  truncated?: boolean;
  disabled?: boolean;
  initialFocus?: boolean;
  onChange: (value: string) => void;
}) {
  const suggestionsId = `${id}-suggestions`;
  const descriptionId = truncated ? `${id}-suggestion-summary` : undefined;
  const exactCount = Math.max(branchCount ?? options.length, options.length);

  return (
    <>
      <input
        id={id}
        name={name}
        list={suggestionsId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="main"
        disabled={disabled}
        aria-describedby={descriptionId}
        {...(initialFocus ? { "data-dialog-initial-focus": true } : {})}
      />
      <datalist id={suggestionsId}>
        {options.map((option) => (
          <option
            key={option}
            value={option}
            label={option === defaultBranch ? "Default" : undefined}
          />
        ))}
      </datalist>
      {truncated && (
        <p id={descriptionId} className="branch-suggestion-summary">
          Showing {options.length.toLocaleString()} of {exactCount.toLocaleString()} local branch
          suggestions. Type another local branch name to use it.
        </p>
      )}
    </>
  );
}
