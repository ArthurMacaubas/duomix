import { useRef } from 'react';
import { dbText, zoneOf } from './Fader.jsx';
import './Knob.css';

const DOTS = 11;
const clamp = (v) => Math.min(100, Math.max(0, v));

/** Botão giratório serrilhado, inspirado no seletor do receptor. Arraste para cima/baixo ou use as setas. */
export default function Knob({ value, onChange, label, disabled }) {
  const drag = useRef(null);
  const angle = -135 + (value / 100) * 270;
  const lit = Math.round((value / 100) * (DOTS - 1));

  const onKeyDown = (e) => {
    const step = { ArrowUp: 2, ArrowRight: 2, ArrowDown: -2, ArrowLeft: -2, PageUp: 10, PageDown: -10 }[e.key];
    if (step !== undefined) onChange(clamp(value + step));
    else if (e.key === 'Home') onChange(0);
    else if (e.key === 'End') onChange(100);
    else return;
    e.preventDefault();
  };

  const onPointerDown = (e) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, start: value };
  };
  const onPointerMove = (e) => {
    if (!drag.current) return;
    onChange(Math.round(clamp(drag.current.start + (drag.current.y - e.clientY) * 0.5)));
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  return (
    <div className="knob">
      <div className="knob__dots" aria-hidden="true">
        {Array.from({ length: DOTS }, (_, i) => {
          const a = (-135 + (i / (DOTS - 1)) * 270) * (Math.PI / 180);
          return (
            <span
              key={i}
              className={`knob__dot${i <= lit && !disabled ? ' is-lit' : ''}`}
              style={{ left: `${50 + Math.sin(a) * 47}%`, top: `${50 - Math.cos(a) * 47}%` }}
            />
          );
        })}
      </div>
      <div
        className={`knob__dial${disabled ? ' is-disabled' : ''}`}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={`${zoneOf(value)}, ${dbText(value)}`}
        aria-disabled={disabled || undefined}
        onKeyDown={disabled ? undefined : onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <span className="knob__cap" style={{ transform: `rotate(${angle}deg)` }}>
          <span className="knob__mark" />
        </span>
      </div>
    </div>
  );
}
