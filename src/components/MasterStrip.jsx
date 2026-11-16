import Knob from './Knob.jsx';
import SegmentMeter from './SegmentMeter.jsx';
import ToggleRow from './ToggleRow.jsx';
import { dbText, zoneOf } from './Fader.jsx';
import { HeadphonesIcon, MicIcon, MicOffIcon, SparkleIcon, SwapIcon } from './Icons.jsx';
import './MasterStrip.css';

/** Saída geral: soma dos dois microfones, com volume no botão giratório, mudo geral e fone. */
export default function MasterStrip({
  master,
  level,
  limiting,
  mutedTalking,
  canAntiBleed,
  ready,
  calibrating,
  autoMessage,
  onChange,
  onAuto,
}) {
  const disabled = !ready;
  return (
    <section className="master" aria-labelledby="master-title">
      <header className="master__head">
        <h2 id="master-title" className="master__title">
          Master
        </h2>
        <span className="master__sub">Saída geral</span>
      </header>

      <Knob
        value={master.volume}
        onChange={(volume) => onChange({ volume })}
        label="Volume geral"
        disabled={disabled}
      />
      <p className="master__readout">
        <strong>{zoneOf(master.volume)}</strong> · {dbText(master.volume)}
      </p>

      <SegmentMeter level={disabled ? 0 : level} segments={24} horizontal />
      <p className={`master__limit${limiting && !disabled ? ' is-on' : ''}`} aria-hidden={!limiting}>
        🛡️ Segurando o estouro
      </p>

      {mutedTalking && (
        <button type="button" className="muted-alert muted-alert--wide" onClick={() => onChange({ muted: false })}>
          <MicOffIcon size={22} />
          <span>
            <strong>Tudo está no mudo e alguém está falando!</strong>
            <span>Toque para ligar a saída</span>
          </span>
        </button>
      )}

      <button
        type="button"
        className={`master__mute${master.muted ? ' is-muted' : ''}`}
        aria-pressed={master.muted}
        aria-keyshortcuts="Control+M"
        disabled={disabled}
        onClick={() => onChange({ muted: !master.muted })}
      >
        {master.muted ? <MicOffIcon size={22} /> : <MicIcon size={22} />}
        {master.muted ? 'Tudo no mudo' : 'Mudo geral'}
        <kbd>Ctrl M</kbd>
      </button>

      <div className="master__toggle">
        <ToggleRow
          icon={<SwapIcon />}
          label="Anti-vazamento"
          help={
            canAntiBleed
              ? 'Quando uma pessoa fala, o microfone da outra abaixa um pouco. Assim a voz não chega duas vezes (com eco) pelos dois microfones.'
              : 'Precisa dos dois microfones em canais separados (receptor em estéreo).'
          }
          checked={master.antiBleed}
          onChange={(antiBleed) => onChange({ antiBleed })}
          disabled={disabled || !canAntiBleed}
        />
        <ToggleRow
          icon={<HeadphonesIcon />}
          label="Me ouvir no fone"
          help="Você escuta a mistura dos dois microfones no fone, já com volume e redutor de ruído. Use com fone para não dar microfonia."
          checked={master.monitor}
          onChange={(monitor) => onChange({ monitor })}
          disabled={disabled}
        />
      </div>

      <button
        type="button"
        className={`btn-yellow${calibrating ? ' is-busy' : ''}`}
        onClick={onAuto}
        disabled={disabled || calibrating}
      >
        <SparkleIcon />
        {calibrating ? 'Ouvindo… falem normalmente' : 'Ajustar tudo sozinho'}
      </button>
      <p className="master__msg" role="status">
        {autoMessage || 'Cada pessoa fala no seu microfone por 5 segundos e eu acerto os volumes.'}
      </p>
    </section>
  );
}
