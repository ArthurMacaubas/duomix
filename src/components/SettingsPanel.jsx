import { useEffect, useRef } from 'react';
import { sliderToDb } from '../hooks/useMixer.js';
import { CloseIcon } from './Icons.jsx';
import './Overlay.css';

const db = (v) => `${sliderToDb(v) > 0 ? '+' : ''}${sliderToDb(v).toFixed(1)} dB`;

/** Ajustes: só o essencial à vista; o técnico fica escondido em "Opções avançadas". */
export default function SettingsPanel({ mixer, onClose, onRestartSetup }) {
  const closeRef = useRef(null);
  const ready = mixer.status === 'ready';

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
          <span className="field__label">Qual receptor usar</span>
          <select
            className="field__select"
            value={mixer.deviceId}
            onChange={(e) => mixer.chooseDevice(e.target.value)}
            disabled={mixer.devices.length === 0}
          >
            {mixer.devices.length === 0 && <option value="">Nenhum receptor encontrado</option>}
            {mixer.devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>

        <details className="advanced">
          <summary>Opções avançadas</summary>
          <dl className="advanced__list">
            <dt>Receptor em uso</dt>
            <dd>{mixer.deviceLabel || '—'}</dd>
            <dt>Modo do receptor</dt>
            <dd>
              {!ready
                ? '—'
                : mixer.dualMono
                  ? 'Estéreo falso: os dois lados chegam iguais (microfones juntos)'
                  : mixer.channelCount === 2
                    ? 'Estéreo (2 canais separados)'
                    : 'Mono (microfones juntos)'}
            </dd>
            <dt>Taxa de amostragem</dt>
            <dd>{mixer.sampleRate ? `${(mixer.sampleRate / 1000).toFixed(1)} kHz` : '—'}</dd>
            {mixer.channels.map((c, i) => (
              <div key={i} className="advanced__pair">
                <dt>
                  TX{i + 1} · {c.name}
                </dt>
                <dd>
                  {db(c.volume)}
                  {ready ? ` · barulho ${mixer.floors[i]} dB` : ''}
                </dd>
              </div>
            ))}
            <dt>Isolador de voz</dt>
            <dd>
              {mixer.isolator.status === 'ready'
                ? mixer.isolator.kind === 'gtcrn'
                  ? 'IA GTCRN, 48 kHz'
                  : 'IA RNNoise, 48 kHz'
                : mixer.isolator.status === 'loading'
                  ? 'Carregando…'
                  : mixer.isolator.status === 'error'
                    ? 'Indisponível neste navegador'
                    : 'Ainda não usado'}
            </dd>
            <dt>Master</dt>
            <dd>{db(mixer.master.volume)}</dd>
            <dt>Atalhos</dt>
            <dd>Ctrl + M mudo geral · Alt + 1 / Alt + 2 mudo de cada microfone</dd>
          </dl>
          <p className="advanced__note">
            A mistura sai pela placa de som do PC (fone, P2 ou Modo Auditório). Ela ainda não vira um microfone que o
            Discord, OBS ou Zoom possam escolher: para isso o app precisa de um microfone virtual.
          </p>
        </details>

        <button type="button" className="btn-secondary sheet__wide" onClick={onRestartSetup}>
          Refazer configuração inicial
        </button>
      </div>
    </div>
  );
}
