import './AuditoriumPanel.css';

const CHECKLIST = [
  'Cabo P2 na saída de fone do PC e numa entrada de LINHA ou AUX da mesa (não na de microfone).',
  'Phantom power (48V) desligado nesse canal da mesa.',
  'Windows no modo "Não incomodar", para notificações não saírem nas caixas.',
  'Volume do Windows entre 80% e 100%. O ajuste fino é feito na mesa.',
  'Comece com o fader da mesa baixo: primeiro o tom de teste, depois a voz.',
  'Notebook na tomada. Se aparecer zumbido, use um isolador de ruído P2.',
];

function latencyInfo(ms, anyIsolate) {
  if (ms == null) return { tone: 'idle', label: '—', hint: 'Conecte o receptor para medir.' };
  if (ms <= 30) return { tone: 'ok', label: `~${ms} ms`, hint: 'Ótimo: quem fala não percebe o atraso.' };
  if (ms <= 60) return { tone: 'mid', label: `~${ms} ms`, hint: 'Bom para auditório. A plateia não percebe.' };
  return {
    tone: 'high',
    label: `~${ms} ms`,
    hint: anyIsolate
      ? 'Alto. Desligar o "Isolar voz" diminui o atraso.'
      : 'Alto. Feche outros programas de áudio ou use outra saída.',
  };
}

/** Painel do Modo Auditório: para onde vai o som, tom de teste, atraso, tela ligada e checklist. */
export default function AuditoriumPanel({ mixer }) {
  const ready = mixer.status === 'ready';
  const live = ready && mixer.outputOn && !mixer.master.muted;
  const anyIsolate = mixer.channels.some((c) => c.isolate);
  const lat = latencyInfo(mixer.latencyMs, anyIsolate);

  return (
    <section className="aud" aria-labelledby="aud-title">
      <header className="aud__head">
        <h2 id="aud-title" className="aud__title">
          Modo Auditório
        </h2>
        <span className={`aud__live${live ? ' is-live' : ''}`} role="status">
          <span className="aud__live-dot" aria-hidden="true" />
          {live ? 'AO VIVO: o som está indo para a mesa' : !ready ? 'Sem receptor' : 'Mudo geral: nada está saindo'}
        </span>
      </header>

      <div className="aud__grid">
        <div className="aud__tile">
          <span className="aud__label" id="aud-out">
            Para onde vai o som
          </span>
          {mixer.sinkSupported ? (
            <select
              className="aud__select"
              aria-labelledby="aud-out"
              value={mixer.outputDeviceId}
              onChange={(e) => mixer.setOutputDeviceId(e.target.value)}
            >
              <option value="">Saída padrão do Windows</option>
              {mixer.outputDevices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          ) : (
            <p className="aud__value aud__value--small">Saída padrão do Windows</p>
          )}
          <p className="aud__hint">Escolha a saída de fone (P2) onde está o cabo da mesa.</p>
        </div>

        <div className="aud__tile">
          <span className="aud__label">Tom de teste</span>
          <button
            type="button"
            className={`aud__tone${mixer.toneOn ? ' is-on' : ''}`}
            aria-pressed={mixer.toneOn}
            disabled={!ready}
            onClick={() => mixer.setToneOn(!mixer.toneOn)}
          >
            {mixer.toneOn ? '■ Parar o tom' : '▶ Tocar tom (1 kHz)'}
          </button>
          <p className={`aud__hint${mixer.toneOn ? ' is-important' : ''}`}>
            {mixer.toneOn
              ? 'Tocando. O técnico sobe o canal na mesa até o medidor dela ficar no 0. Para sozinho em 1 minuto.'
              : 'Um apito constante para o técnico acertar o volume na mesa antes de começar.'}
          </p>
        </div>

        <div className="aud__tile">
          <span className="aud__label">Atraso no PC</span>
          <p className={`aud__value aud__value--${lat.tone}`}>{lat.label}</p>
          <p className={`aud__hint${lat.tone === 'high' ? ' is-important' : ''}`}>
            {lat.hint} Estimativa do navegador, sem contar o próprio Lark.
          </p>
        </div>

        <div className="aud__tile">
          <span className="aud__label">Tela do PC</span>
          <p className={`aud__value aud__value--${mixer.wakeLock === 'on' ? 'ok' : 'mid'}`}>
            {mixer.wakeLock === 'on' ? 'Sempre ligada ✓' : 'Pode apagar'}
          </p>
          <p className={`aud__hint${mixer.wakeLock !== 'on' ? ' is-important' : ''}`}>
            {mixer.wakeLock === 'on'
              ? 'O PC não vai dormir enquanto o Modo Auditório estiver ligado.'
              : 'Este navegador não segurou a tela. Desative a suspensão do Windows antes do evento.'}
          </p>
        </div>
      </div>

      <details className="aud__check">
        <summary>Antes de começar: checklist da ligação</summary>
        <ol>
          {CHECKLIST.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      </details>
    </section>
  );
}
