import { useEffect, useState } from 'react';
import MicGrille from './MicGrille.jsx';
import ProblemBanner from './ProblemBanner.jsx';
import './Overlay.css';

const STEPS = 3;

/** Primeiro uso em 3 passos: boas-vindas, conectar e testar a voz. */
export default function Onboarding({ mic, onDone }) {
  const [step, setStep] = useState(0);
  const [result, setResult] = useState(null); // null | 'ok' | 'silent'
  const ready = mic.status === 'ready';

  // Passo 2 avança sozinho quando o microfone aparece.
  useEffect(() => {
    if (step !== 1 || !ready) return;
    const t = setTimeout(() => setStep(2), 1000);
    return () => clearTimeout(t);
  }, [step, ready]);

  const runTest = async () => {
    setResult(null);
    const r = await mic.autoAdjust();
    setResult(r.ok ? 'ok' : r.reason === 'silent' ? 'silent' : null);
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
            <img src="/mic.svg" alt="" width="88" height="88" className="onboarding__logo" />
            <h2 id="ob-title" className="onboarding__title">
              Bem-vindo ao Rubro
            </h2>
            <p className="onboarding__text">Vamos deixar sua voz perfeita em 1 minuto.</p>
            <button type="button" className="btn-primary" onClick={() => setStep(1)}>
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
              {ready ? 'Achei seu microfone! ✅' : 'Conecte seu microfone'}
            </h2>
            <p className="onboarding__text">
              {ready
                ? mic.deviceLabel
                : 'Encaixe o cabo USB no computador. Se aparecer um aviso pedindo o microfone, clique em "Permitir".'}
            </p>
            {!ready && <ProblemBanner status={mic.status} onRetry={mic.retry} />}
          </div>
        )}

        {step === 2 && (
          <div className="onboarding__step">
            <MicGrille bands={mic.bands} compact />
            <h2 id="ob-title" className="onboarding__title">
              {result === 'ok' ? 'Pronto! Seu microfone está no ponto ✅' : 'Diga: "Olá, testando!"'}
            </h2>
            <p className="onboarding__text">
              {mic.calibrating
                ? 'Continue falando normalmente… estou ajustando.'
                : result === 'silent'
                  ? 'Não consegui te ouvir. Chegue mais perto do microfone e tente de novo.'
                  : result === 'ok'
                    ? 'Ajustei o volume da sua voz. Você pode mudar quando quiser.'
                    : 'Toque no botão e fale por 5 segundos. Eu ajusto o volume para você.'}
            </p>
            {result === 'ok' ? (
              <button type="button" className="btn-primary" onClick={onDone}>
                Concluir
              </button>
            ) : (
              <button type="button" className="btn-primary" onClick={runTest} disabled={mic.calibrating || !ready}>
                {mic.calibrating ? 'Ouvindo…' : result === 'silent' ? 'Tentar de novo' : 'Começar teste'}
              </button>
            )}
          </div>
        )}

        {!(step === 2 && result === 'ok') && (
          <button type="button" className="onboarding__skip" onClick={onDone}>
            Pular
          </button>
        )}
      </div>
    </div>
  );
}
