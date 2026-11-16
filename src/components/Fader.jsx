import { sliderToDb } from '../hooks/useMixer.js';
import './Fader.css';

const zoneOf = (v) => (v < 34 ? 'Baixo' : v > 66 ? 'Alto' : 'Ideal');
const dbText = (v) => {
  const db = Math.round(sliderToDb(v));
  return `${db > 0 ? '+' : ''}${db} dB`;
};

/** Fader vertical de mesa de som (um <input type="range"> nativo, acessível por teclado). */
export default function Fader({ value, onChange, label, disabled }) {
  return (
    <div className="fader">
      <div className="fader__scale" aria-hidden="true">
        <span>+12</span>
        <span>0</span>
        <span>−12</span>
      </div>
      <input
        className="fader__input"
        type="range"
        min="0"
        max="100"
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={`${zoneOf(value)}, ${dbText(value)}`}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

export { zoneOf, dbText };
