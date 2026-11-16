import { useEffect, useRef } from 'react';
import { CloseIcon } from './Icons.jsx';
import './Overlay.css';

/** Ajustes: só o essencial à vista; o técnico fica escondido em "Opções avançadas". */
export default function SettingsPanel({ mic, onClose, onRestartSetup }) {
  const closeRef = useRef(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="sheet__head">
          <h2 id="settings-title" className="sheet__title">
            Ajustes
          </h2>
          <button ref={closeRef} type="button" className="icon-btn" aria-label="Fechar ajustes" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <label className="field">
          <span className="field__label">Qual microfone usar</span>
          <select
            className="field__select"
            value={mic.deviceId}
            onChange={(e) => mic.chooseDevice(e.target.value)}
            disabled={mic.devices.length === 0}
          >
            {mic.devices.length === 0 && <option value="">Nenhum microfone encontrado</option>}
            {mic.devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>

        <details className="advanced">
          <summary>Opções avançadas</summary>
          <dl className="advanced__list">
            <dt>Microfone em uso</dt>
            <dd>{mic.deviceLabel || '—'}</dd>
            <dt>Taxa de amostragem</dt>
            <dd>{mic.sampleRate ? `${(mic.sampleRate / 1000).toFixed(1)} kHz` : '—'}</dd>
            <dt>Volume da voz (ganho no app)</dt>
            <dd>{`${(((mic.volume - 50) / 50) * 12).toFixed(1)} dB`}</dd>
            <dt>Atalho de mudo</dt>
            <dd>Ctrl + M (com o app aberto)</dd>
          </dl>
          <p className="advanced__note">
            Nesta versão web, o volume é ajustado dentro do app. O controle direto do hardware (ganho físico, LED e
            botão de mudo do microfone) chega na versão para computador.
          </p>
        </details>

        <button type="button" className="btn-secondary sheet__wide" onClick={onRestartSetup}>
          Refazer configuração inicial
        </button>
      </div>
    </div>
  );
}
