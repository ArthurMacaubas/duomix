import { SparkleIcon, SpeakerHighIcon, SpeakerLowIcon } from './Icons.jsx';
import './VolumeSlider.css';

const zoneOf = (v) => (v < 34 ? 'Baixo' : v > 66 ? 'Alto' : 'Ideal');

export default function VolumeSlider({ value, onChange, onAuto, calibrating, autoMessage, disabled }) {
  return (
    <section className="card volume" aria-labelledby="volume-title">
      <div className="volume__head">
        <h2 id="volume-title" className="card__title">
          Volume da sua voz
        </h2>
        <span className="volume__zone">{zoneOf(value)}</span>
      </div>

      <div className="volume__row">
        <SpeakerLowIcon />
        <input
          className="volume__range"
          type="range"
          min="0"
          max="100"
          value={value}
          disabled={disabled || calibrating}
          style={{ '--fill': `${value}%` }}
          aria-labelledby="volume-title"
          aria-valuetext={zoneOf(value)}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <SpeakerHighIcon />
      </div>
      <div className="volume__zones" aria-hidden="true">
        <span>Baixo</span>
        <span>Ideal</span>
        <span>Alto</span>
      </div>

      <button
        type="button"
        className={`btn-primary${calibrating ? ' is-busy' : ''}`}
        onClick={onAuto}
        disabled={disabled || calibrating}
      >
        <SparkleIcon />
        {calibrating ? 'Ouvindo… fale normalmente' : 'Ajustar sozinho'}
      </button>
      {autoMessage && (
        <p className="volume__msg" role="status">
          {autoMessage}
        </p>
      )}
    </section>
  );
}
