import { useId, useState } from 'react';
import './ToggleRow.css';

/** Interruptor grande com explicação em linguagem do dia a dia. */
export default function ToggleRow({ icon, label, help, checked, onChange, disabled }) {
  const [showHelp, setShowHelp] = useState(false);
  const labelId = useId();
  const helpId = useId();
  return (
    <div className="toggle">
      <div className="toggle__main">
        <span className="toggle__icon" aria-hidden="true">
          {icon}
        </span>
        <span id={labelId} className="toggle__label">
          {label}
        </span>
        <button
          type="button"
          className="toggle__help-btn"
          aria-label={`O que é "${label}"?`}
          aria-expanded={showHelp}
          aria-controls={helpId}
          onClick={() => setShowHelp((s) => !s)}
        >
          ?
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-labelledby={labelId}
          className={`switch${checked ? ' is-on' : ''}`}
          disabled={disabled}
          onClick={() => onChange(!checked)}
        >
          <span className="switch__knob" />
        </button>
      </div>
      {showHelp && (
        <p id={helpId} className="toggle__help">
          {help}
        </p>
      )}
    </div>
  );
}
