import { useCallback, useEffect, useRef, useState } from 'react';
import { useMicrophone } from './hooks/useMicrophone.js';
import Header from './components/Header.jsx';
import StatusBadge from './components/StatusBadge.jsx';
import MicGrille from './components/MicGrille.jsx';
import MuteButton from './components/MuteButton.jsx';
import VolumeSlider from './components/VolumeSlider.jsx';
import ToggleRow from './components/ToggleRow.jsx';
import ProblemBanner from './components/ProblemBanner.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import Onboarding from './components/Onboarding.jsx';
import NoiseReducer from './components/NoiseReducer.jsx';
import { HeadphonesIcon } from './components/Icons.jsx';
import './App.css';

function readOnboarded() {
  try {
    return localStorage.getItem('mm:onboarded') === '1';
  } catch {
    return false;
  }
}

/** Frase de feedback no lugar de números: o que o leigo precisa saber. */
function voiceMessage({ status, muted, calibrating, voiceLevel }) {
  if (status !== 'ready') return { tone: 'idle', text: 'Esperando o microfone…' };
  if (calibrating) return { tone: 'ok', text: 'Fale normalmente… estou ajustando.' };
  if (muted) return { tone: 'muted', text: 'Você está no mudo. Ninguém te ouve.' };
  if (voiceLevel < 0.15) return { tone: 'idle', text: 'Fale algo para testar…' };
  if (voiceLevel < 0.45) return { tone: 'low', text: 'Tá meio baixinho. Chegue mais perto ou toque em "Ajustar sozinho".' };
  if (voiceLevel < 0.88) return { tone: 'ok', text: 'Estou te ouvindo bem! 👍' };
  return { tone: 'warn', text: 'Opa, tá estourando! Afaste um pouco.' };
}

export default function App() {
  const mic = useMicrophone();
  const [showSettings, setShowSettings] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(() => !readOnboarded());
  const [autoMessage, setAutoMessage] = useState('');
  const autoMsgTimer = useRef(0);

  const ready = mic.status === 'ready';
  const message = voiceMessage(mic);

  // Atalho Ctrl+M para mudo (funciona com o app em foco).
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'm' && ready) {
        e.preventDefault();
        mic.toggleMute();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ready, mic.toggleMute]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => clearTimeout(autoMsgTimer.current), []);

  const handleAuto = useCallback(async () => {
    setAutoMessage('');
    const r = await mic.autoAdjust();
    setAutoMessage(
      r.ok
        ? 'Pronto! Ajustei o volume da sua voz. ✅'
        : r.reason === 'silent'
          ? 'Não consegui te ouvir. Chegue mais perto e tente de novo.'
          : '',
    );
    clearTimeout(autoMsgTimer.current);
    autoMsgTimer.current = setTimeout(() => setAutoMessage(''), 6000);
  }, [mic]);

  const finishOnboarding = () => {
    try {
      localStorage.setItem('mm:onboarded', '1');
    } catch {
      /* sem armazenamento: o guia aparece de novo na próxima vez */
    }
    setShowOnboarding(false);
  };

  return (
    <div className="app">
      <Header onSettings={() => setShowSettings(true)} onHelp={() => setShowOnboarding(true)} />

      <main className="app__main">
        <div className="app__top">
          <StatusBadge status={mic.status} />
          {!ready && !['idle', 'requesting'].includes(mic.status) && (
            <ProblemBanner status={mic.status} onRetry={mic.retry} />
          )}
        </div>

        <div className="layout">
          {/* O "corpo do microfone": metal escovado, parafusos e plaqueta gravada. */}
          <section className="device" aria-label="Seu microfone">
            <span className="device__screw device__screw--tl" aria-hidden="true" />
            <span className="device__screw device__screw--tr" aria-hidden="true" />
            <span className="device__screw device__screw--bl" aria-hidden="true" />
            <span className="device__screw device__screw--br" aria-hidden="true" />

            <div className="device__plate">
              <span className={`device__led${ready ? (mic.muted ? ' is-muted' : ' is-live') : ''}`} aria-hidden="true" />
              <span className="device__brand">Rubro</span>
              <span className="device__model">{ready ? mic.deviceLabel : 'sem microfone'}</span>
            </div>

            <MicGrille bands={mic.bands} idle={!ready} />
            <p className={`meter__msg meter__msg--${message.tone}`}>{message.text}</p>
            <MuteButton muted={mic.muted} level={mic.level} disabled={!ready} onToggle={mic.toggleMute} />
          </section>

          <div className="controls">
            <VolumeSlider
              value={mic.volume}
              onChange={mic.setVolume}
              onAuto={handleAuto}
              calibrating={mic.calibrating}
              autoMessage={autoMessage}
              disabled={!ready}
            />
    
            <NoiseReducer
              value={mic.noiseLevel}
              onChange={mic.setNoiseLevel}
              floorDb={mic.noiseFloorDb}
              gateClosed={mic.gateClosed}
              disabled={!ready}
            />
    
            <section className="card" aria-label="Extras">
              <ToggleRow
                icon={<HeadphonesIcon />}
                label="Me ouvir no fone"
                help="Você escuta a própria voz no fone de ouvido enquanto fala, já com o redutor de ruído. Use com fone para não dar microfonia."
                checked={mic.monitor}
                onChange={mic.setMonitor}
                disabled={!ready}
              />
            </section>
          </div>
        </div>
      </main>

      <footer className="app__footer">
        Rubro · criado por <strong>Arthur Macaúbas</strong> · © {new Date().getFullYear()}
      </footer>

      <p className="sr-only" aria-live="assertive">
        {ready ? (mic.muted ? 'Microfone no mudo' : 'Microfone ligado') : ''}
      </p>

      {showSettings && (
        <SettingsPanel
          mic={mic}
          onClose={() => setShowSettings(false)}
          onRestartSetup={() => {
            setShowSettings(false);
            setShowOnboarding(true);
          }}
        />
      )}
      {showOnboarding && <Onboarding mic={mic} onDone={finishOnboarding} />}
    </div>
  );
}
