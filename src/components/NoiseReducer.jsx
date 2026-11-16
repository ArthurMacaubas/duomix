import { WindIcon } from './Icons.jsx';
import './NoiseReducer.css';

const OPTIONS = [
  { value: 'off', label: 'Desligado', help: 'Seu som passa do jeito que chega no microfone.' },
  { value: 'leve', label: 'Leve', help: 'Tira ronco, ventilador e chiado sem mexer na sua voz.' },
  {
    value: 'forte',
    label: 'Forte',
    help: 'Tudo do Leve e ainda abaixa o som quando você não está falando. Ótimo para lugar barulhento.',
  },
];

function ambientOf(floorDb) {
  if (floorDb < -62) return { tone: 'ok', text: 'Baixo' };
  if (floorDb < -48) return { tone: 'mid', text: 'Médio' };
  return { tone: 'high', text: 'Alto' };
}

/** Redutor de ruído em 3 níveis, com leitura do barulho do ambiente. */
export default function NoiseReducer({ value, onChange, floorDb, gateClosed, disabled }) {
  const current = OPTIONS.find((o) => o.value === value) ?? OPTIONS[1];
  const ambient = ambientOf(floorDb);

  const onKeyDown = (e) => {
    const i = OPTIONS.findIndex((o) => o.value === value);
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = OPTIONS[(i + 1) % OPTIONS.length];
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = OPTIONS[(i - 1 + OPTIONS.length) % OPTIONS.length];
    if (next) {
      e.preventDefault();
      onChange(next.value);
      e.currentTarget.querySelector(`[data-value="${next.value}"]`)?.focus();
    }
  };

  return (
    <section className="card noise" aria-labelledby="noise-title">
      <div className="noise__head">
        <span className="noise__icon" aria-hidden="true">
          <WindIcon />
        </span>
        <h2 id="noise-title" className="card__title">
          Redutor de ruído
        </h2>
      </div>

      <div className="segmented" role="radiogroup" aria-labelledby="noise-title" onKeyDown={onKeyDown}>
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            data-value={o.value}
            aria-checked={value === o.value}
            tabIndex={value === o.value ? 0 : -1}
            className={`segmented__opt${value === o.value ? ' is-on' : ''}`}
            disabled={disabled}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>

      <p className="noise__help">{current.help}</p>

      {!disabled && (
        <div className="noise__ambient">
          <span>
            Barulho do ambiente: <strong className={`noise__amb--${ambient.tone}`}>{ambient.text}</strong>
          </span>
          {value === 'forte' && gateClosed && <span className="noise__chip">🤫 Silenciando o barulho</span>}
          {value !== 'forte' && ambient.tone === 'high' && (
            <button type="button" className="noise__suggest" onClick={() => onChange('forte')}>
              Usar o modo Forte
            </button>
          )}
        </div>
      )}
    </section>
  );
}
