import { useState } from 'react';

/**
 * Two-step button for consequential actions. Browser confirm()/prompt() dialogs are not used:
 * they are blocked in some embedded views and easy to click through.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled,
  className = 'btn danger',
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <button
        type="button"
        className={className}
        disabled={disabled}
        onClick={() => setArmed(true)}
      >
        {label}
      </button>
    );
  }
  return (
    <span className="confirm-group">
      <button
        type="button"
        className={className}
        disabled={disabled}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button type="button" className="btn ghost" onClick={() => setArmed(false)}>
        Cancel
      </button>
    </span>
  );
}
