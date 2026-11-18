import { useEffect, useState } from 'react';
import ProblemBanner from './ProblemBanner.jsx';
import SegmentMeter from './SegmentMeter.jsx';
import './Overlay.css';

const STEPS = 3;

/** Primeiro uso em 3 passos: boas-vindas, conectar o receptor e testar os dois microfones. */
export default function Onboarding({ mixer, onDone }) {
  const [step, setStep] = useState(0);
  const [results, setResults] = useState(null);
  const ready = mixer.status === 'ready';
  const ok = results?.some((r) => typeof r === 'number');

  // Passo 2 avança sozinho quando o receptor aparece.
  useEffect(() => {
    if (step !== 1 || !ready) return;
    const t = setTimeout(() => setStep(2), 1000);
    return () => clearTimeout(t);
  }, [step, ready]);

  const runTest = async () => {
    setResults(null);
    const r = await mixer.autoAdjust();
    setResults(r.results);
  };

  const statusOf = (i) => {
    if (!results) return '';
    const r = results[i];
    if (typeof r === 'number') return 'ajustado ✅';
    if (r === 'mono') return 'misturado no canal 1';
    return 'não ouvi';
  };

  return (
    <div className="overlay overlay--full">
      <div className="sheet onboarding" role="dialog" aria-modal="true" aria-labelledby="ob-title">
        <div className="onboarding__stripe" aria-hidden="true" />
        <ol className="onboarding__dots" aria-label={`Passo ${step + 1} de ${STEPS}`}>
          {Array.from({ length: STEPS }, (_, i) => (
            <li key={i} className={i <= step ? 'is-done' : ''} />
          ))}
        </ol>

        {step === 0 && (
          <div className="onboarding__step">
            <img src="/logo.svg" alt="" width="88" height="88" className="onboarding__logo" />
            <h2 id="ob-title" className="onboarding__title">
              Bem-vindo ao DuoMix
            </h2>
            <p className="onboarding__text">
              Uma mesa de som para seus dois microfones sem fio. Em 1 minuto deixamos os dois no ponto.
            </p>
            <button type="button" className="btn-yellow" onClick={() => setStep(1)}>
              Começar
            </button>
          </div>
        )}

        {step === 1 && (
          <div className="onboarding__step">
            <div className={`plug${ready ? ' is-ready' : ''}`} aria-hidden="true">
              <span className="plug__mic" />
              <span className="plug__cable" />
              <span className="plug__usb" />
            </div>
            <h2 id="ob-title" className="onboarding__title">
              {ready ? 'Achei seu receptor! ✅' : 'Conecte o receptor'}
            </h2>
            <p className="onboarding__text">
              {ready
                ? mixer.deviceLabel
                : 'Encaixe o receptor na porta USB-C do computador e ligue os dois microfones. Se aparecer um aviso, clique em "Permitir".'}
            </p>
            <p className="onboarding__text onboarding__text--small">
              Usa um receptor para cada microfone (dois kits)? Depois escolha &quot;Um receptor para cada microfone&quot; em ⚙
              Ajustes.
            </p>
            {!ready && <ProblemBanner status={mixer.status} onRetry={mixer.retry} />}
          </div>
        )}

        {step === 2 && (
          <div className="onboarding__step">
            <h2 id="ob-title" className="onboarding__title">
              {ok ? 'Pronto! A mesa está no ponto ✅' : 'Agora cada um fala no seu microfone'}
            </h2>
            <div className="ob-meters">
              {mixer.channels.map((c, i) => (
                <div key={i} className="ob-meters__row">
                  <span className="ob-meters__name">
                    TX{i + 1} · {c.name}
                  </span>
                  <SegmentMeter level={mixer.meters.ch[i].level} segments={20} horizontal />
                  <span className="ob-meters__status">{statusOf(i)}</span>
                </div>
              ))}
            </div>
            <p className="onboarding__text">
              {mixer.calibrating
                ? 'Continuem falando normalmente… estou ajustando.'
                : ok
                  ? 'Ajustei o volume de cada microfone. Vocês podem mudar quando quiserem.'
                  : results
                    ? 'Não consegui ouvir. Cheguem mais perto dos microfones e tentem de novo.'
                    : 'Toque no botão e falem por 5 segundos, como numa conversa. Eu acerto os volumes.'}
            </p>
            {ok ? (
              <button type="button" className="btn-yellow" onClick={onDone}>
                Abrir a mesa
              </button>
            ) : (
              <button type="button" className="btn-yellow" onClick={runTest} disabled={mixer.calibrating || !ready}>
                {mixer.calibrating ? 'Ouvindo…' : results ? 'Tentar de novo' : 'Começar teste'}
              </button>
            )}
          </div>
        )}

        {!(step === 2 && ok) && (
          <button type="button" className="onboarding__skip" onClick={onDone}>
            Pular
          </button>
        )}
      </div>
    </div>
  );
}
