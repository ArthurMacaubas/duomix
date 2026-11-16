import { MicIcon, MicOffIcon } from './Icons.jsx';
import './MuteButton.css';

/** O protagonista: mesmo formato e comportamento do botão físico do microfone. */
export default function MuteButton({ muted, level, disabled, onToggle }) {
  return (
    <div className="mute">
      <button
        type="button"
        className={`mute__btn${disabled ? ' is-off' : muted ? ' is-muted' : ' is-live'}`}
        style={{ '--pulse': muted || disabled ? 0 : level }}
        aria-pressed={muted}
        aria-label={muted ? 'Microfone no mudo. Clique para ligar.' : 'Microfone ligado. Clique para silenciar.'}
        aria-keyshortcuts="Control+M"
        disabled={disabled}
        onClick={onToggle}
      >
        <span className="mute__ring" aria-hidden="true" />
        <span className="mute__face">
          {muted || disabled ? <MicOffIcon size={44} /> : <MicIcon size={44} />}
          <span className="mute__label">{disabled ? 'SEM MIC' : muted ? 'MUDO' : 'LIGADO'}</span>
        </span>
      </button>
      <p className="mute__caption">
        {disabled ? 'Conecte o microfone para usar' : muted ? 'Ninguém te ouve' : 'Estão te ouvindo'}
        <kbd>Ctrl + M</kbd>
      </p>
    </div>
  );
}
