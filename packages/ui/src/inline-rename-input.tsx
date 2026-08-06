import { useEffect, useRef } from 'react';

/**
 * The rename-in-place text field: focus-and-select on mount, Enter commits,
 * Escape cancels, blur commits.
 *
 * It exists because three surfaces need exactly this field — the sidebar's
 * session row, the sidebar's project group row, and the titlebar's session
 * breadcrumb — and the first two carried the same twenty lines twice over,
 * including both non-obvious parts:
 *
 * - `escapeCancelledRef` — Escape moves focus off the field, so the blur
 *   handler would fire right behind the cancel and commit the very edit that
 *   was just abandoned. The flag lets the blur that Escape caused pass through
 *   without committing, and is cleared so a later real blur still commits.
 * - the `isComposing` / `'Process'` guard — a Chinese, Japanese, or Korean IME
 *   sends Enter to accept its candidate. Without the guard that keystroke
 *   commits a half-typed name and closes the field mid-word.
 *
 * Uncontrolled by design: the value belongs to the DOM for the life of the
 * edit, and the caller only ever hears the final string. There is no state to
 * synchronize and no re-render per keystroke.
 */
export function InlineRenameInput(props: {
  defaultValue: string;
  ariaLabel: string;
  /** Surface-specific sizing only. The field's own chrome is `maka-inline-rename`. */
  className?: string;
  onCommit(name: string): void;
  onCancel(): void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const escapeCancelledRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      className={props.className ? `maka-inline-rename ${props.className}` : 'maka-inline-rename'}
      defaultValue={props.defaultValue}
      maxLength={80}
      aria-label={props.ariaLabel}
      onBlur={(event) => {
        if (escapeCancelledRef.current) {
          escapeCancelledRef.current = false;
          return;
        }
        props.onCommit(event.currentTarget.value.trim());
      }}
      onKeyDown={(event) => {
        // The sidebar and the titlebar both sit under keyboard shortcuts that
        // would otherwise read these keystrokes as navigation.
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.key === 'Process') return;
        if (event.key === 'Enter') {
          event.preventDefault();
          props.onCommit(event.currentTarget.value.trim());
        } else if (event.key === 'Escape') {
          event.preventDefault();
          escapeCancelledRef.current = true;
          props.onCancel();
        }
      }}
      autoComplete="off"
      spellCheck={false}
    />
  );
}
