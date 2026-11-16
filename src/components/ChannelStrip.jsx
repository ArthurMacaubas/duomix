import SegmentMeter from './SegmentMeter.jsx';
import Fader, { dbText, zoneOf } from './Fader.jsx';
import ToggleRow from './ToggleRow.jsx';
import { LevelIcon, MicIcon, MicOffIcon, SparkleIcon } from './Icons.jsx';
import './ChannelStrip.css';

const NOISE_OPTIONS = [
  { value: 'off', label: 'Off', help: 'Sem redutor de ruído' },
  { value: 'leve', label: 'Leve', help: 'Tira ronco, ventilador e chiado' },
  { value: 'forte', label: 'Forte', help: 'Também abaixa o som quando a pessoa não está falando' },
];

/** Frase curta em vez de números: o que o leigo precisa saber deste microfone. */
function channelMessage({ ready, inactive, muted, calibrating, meter }) {
  if (!ready) return { tone: 'idle', text: 'Esperando o receptor…' };
  if (inactive) return { tone: 'idle', text: 'Sem sinal separado' };
  if (calibrating) return { tone: 'ok', text: 'Fale normalmente…' };
  if (muted) return { tone: 'muted', text: 'No mudo' };
  if (meter.clip || meter.voice >= 0.9) return { tone: 'warn', text: 'Tá estourando!' };
  if (meter.voice < 0.15) return { tone: 'idle', text: 'Fale algo…' };
  if (meter.voice < 0.45) return { tone: 'low', text: 'Meio baixinho' };
  return { tone: 'ok', text: 'Ouvindo bem 👍' };
}

const ambientOf = (db) => (db < -62 ? 'Baixo' : db < -48 ? 'Médio' : 'Alto');

/** Canal da mesa: um microfone (TX1 ou TX2) com nome, medidor, fader, mudo e redutor de ruído. */
export default function ChannelStrip({
  index,
  cfg,
  meter,
  floorDb,
  gateClosed,
  ready,
  inactive,
  calibrating,
  isolator,
  ducked,
  duckedBy,
  mutedTalking,
  onChange,
  onRetryIsolator,
}) {
  const disabled = !ready || inactive;
  const msg = channelMessage({ ready, inactive, muted: cfg.muted, calibrating, meter });
  const live = !disabled && !cfg.muted && meter.level > 0.12;
  const n = index + 1;

  return (
    <section className={`strip${disabled ? ' is-disabled' : ''}`} aria-labelledby={`strip-name-${n}`}>
      <header className="strip__head">
        <span className={`strip__badge${live ? ' is-live' : ''}`} aria-hidden="true">
          <span className="strip__badge-led" />
          TX{n}
        </span>
        <input
          id={`strip-name-${n}`}
          className="strip__name"
          value={cfg.name}
          maxLength={20}
          aria-label={`Nome do canal ${n}`}
          onChange={(e) => onChange({ name: e.target.value })}
          onBlur={(e) => !e.target.value.trim() && onChange({ name: `Microfone ${n}` })}
        />
      </header>

      {mutedTalking ? (
        <button type="button" className="muted-alert" onClick={() => onChange({ muted: false })}>
          <MicOffIcon size={20} />
          <span>
            <strong>Você está no mudo!</strong>
            <span>Toque para ligar</span>
          </span>
        </button>
      ) : (
        <p className={`strip__msg strip__msg--${msg.tone}`}>{msg.text}</p>
      )}

      <div className="strip__body">
        <SegmentMeter level={disabled ? 0 : meter.level} clip={!disabled && meter.clip} />
        <Fader
          value={cfg.volume}
          onChange={(volume) => onChange({ volume })}
          label={`Volume de ${cfg.name}`}
          disabled={disabled}
        />
      </div>

      <p className="strip__readout">
        <strong>{zoneOf(cfg.volume)}</strong> · {dbText(cfg.volume)}
      </p>
      <p className={`strip__duck${ducked && !disabled && !cfg.muted ? ' is-on' : ''}`} aria-hidden={!ducked || cfg.muted}>
        ↓ Abaixado: {duckedBy || 'outro microfone'} falando
      </p>

      <button
        type="button"
        className={`strip__mute${cfg.muted ? ' is-muted' : ''}`}
        aria-pressed={cfg.muted}
        aria-keyshortcuts={`Alt+${n}`}
        disabled={disabled}
        onClick={() => onChange({ muted: !cfg.muted })}
      >
        {cfg.muted ? <MicOffIcon size={20} /> : <MicIcon size={20} />}
        {cfg.muted ? 'Mudo' : 'Ligado'}
        <kbd>Alt {n}</kbd>
      </button>

      <div className="strip__iso">
        <button
          type="button"
          role="switch"
          aria-checked={cfg.isolate}
          aria-describedby={`iso-help-${n}`}
          className={`iso-btn${cfg.isolate ? ' is-on' : ''}`}
          disabled={disabled}
          onClick={() => onChange({ isolate: !cfg.isolate })}
        >
          <SparkleIcon size={18} />
          <span className="iso-btn__label">Isolar voz</span>
          <span className="iso-btn__state">{cfg.isolate ? 'Ligado' : 'Desligado'}</span>
        </button>
        <span id={`iso-help-${n}`} className="strip__ambient">
          {!cfg.isolate
            ? 'IA que deixa só a voz, até enquanto a pessoa fala'
            : isolator.status === 'loading'
              ? 'Carregando a IA…'
              : isolator.status === 'error'
                ? 'Não consegui ligar a IA neste navegador'
                : '✨ Só a voz está passando'}
        </span>
        {cfg.isolate && isolator.status === 'error' && (
          <button type="button" className="btn-secondary iso-retry" onClick={onRetryIsolator}>
            Tentar de novo
          </button>
        )}
      </div>

      <div className="strip__leveler">
        <ToggleRow
          icon={<LevelIcon size={20} />}
          label="Nivelar voz"
          help="Sobe quem fala baixo e segura quem fala alto, para a voz ficar sempre no mesmo volume sem mexer no fader."
          checked={cfg.leveler}
          onChange={(leveler) => onChange({ leveler })}
          disabled={disabled}
        />
        <span className="strip__ambient strip__leveler-help">Sobe quem fala baixo e segura quem grita</span>
      </div>

      <div className="strip__noise">
        <span className="strip__label" id={`noise-${n}`}>
          Redutor de ruído
        </span>
        <div className="mini-seg" role="radiogroup" aria-labelledby={`noise-${n}`}>
          {NOISE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={cfg.noise === o.value}
              title={o.help}
              className={`mini-seg__opt${cfg.noise === o.value ? ' is-on' : ''}`}
              disabled={disabled}
              onClick={() => onChange({ noise: o.value })}
            >
              {o.label}
            </button>
          ))}
        </div>
        <span className="strip__ambient">
          {disabled ? '—' : gateClosed && cfg.noise === 'forte' ? '🤫 Silenciando o barulho' : `Barulho: ${ambientOf(floorDb)}`}
        </span>
      </div>

      {inactive && ready && (
        <p className="strip__mono">
          Seu receptor está mandando os dois microfones juntos (modo mono). Eles aparecem misturados no canal 1. Para
          separar, coloque o receptor em modo estéreo.
        </p>
      )}
    </section>
  );
}
