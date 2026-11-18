import { useCallback, useEffect, useRef, useState } from 'react';
import { CHANNELS, useMixer } from './hooks/useMixer.js';
import Header from './components/Header.jsx';
import StatusBadge from './components/StatusBadge.jsx';
import ProblemBanner from './components/ProblemBanner.jsx';
import ChannelStrip from './components/ChannelStrip.jsx';
import MasterStrip from './components/MasterStrip.jsx';
import AuditoriumPanel from './components/AuditoriumPanel.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import Onboarding from './components/Onboarding.jsx';
import './App.css';

function readOnboarded() {
  try {
    return localStorage.getItem('dm:onboarded') === '1';
  } catch {
    return false;
  }
}

function describeAuto(results, channels) {
  const done = [];
  const silent = [];
  results.forEach((r, i) => {
    if (typeof r === 'number') done.push(channels[i].name);
    else if (r === 'silent') silent.push(channels[i].name);
  });
  if (!done.length) return 'Não consegui ouvir ninguém. Cheguem mais perto dos microfones e tentem de novo.';
  let text = `Pronto! Ajustei ${done.join(' e ')}. ✅`;
  if (silent.length) text += ` Não ouvi ${silent.join(' e ')}.`;
  return text;
}

export default function App() {
  const mixer = useMixer();
  const [showSettings, setShowSettings] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(() => !readOnboarded());
  const [autoMessage, setAutoMessage] = useState('');
  const [announce, setAnnounce] = useState('');
  const autoMsgTimer = useRef(0);

  const ready = mixer.status === 'ready';
  const { channels, master, setChannel, setMaster } = mixer;

  // Atalhos: Ctrl+M mudo geral; Alt+1 / Alt+2 mudo de cada microfone.
  useEffect(() => {
    const onKey = (e) => {
      if (!ready) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        setMaster({ muted: !master.muted });
        setAnnounce(master.muted ? 'Saída geral ligada' : 'Tudo no mudo');
      } else if (e.altKey && ['1', '2'].includes(e.key)) {
        const i = Number(e.key) - 1;
        if (i >= mixer.channelCount) return;
        e.preventDefault();
        setChannel(i, { muted: !channels[i].muted });
        setAnnounce(`${channels[i].name} ${channels[i].muted ? 'ligado' : 'no mudo'}`);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ready, master.muted, channels, mixer.channelCount, setChannel, setMaster]);

  useEffect(() => () => clearTimeout(autoMsgTimer.current), []);

  const { mutedTalking } = mixer;
  useEffect(() => {
    if (mutedTalking.master) setAnnounce('Tudo está no mudo e alguém está falando');
    else {
      const i = mutedTalking.ch.findIndex(Boolean);
      if (i >= 0) setAnnounce(`${channels[i].name}: você está no mudo`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutedTalking]);

  const handleAuto = useCallback(async () => {
    setAutoMessage('');
    const r = await mixer.autoAdjust();
    setAutoMessage(r.results.length ? describeAuto(r.results, channels) : '');
    clearTimeout(autoMsgTimer.current);
    autoMsgTimer.current = setTimeout(() => setAutoMessage(''), 8000);
  }, [mixer, channels]);

  const finishOnboarding = () => {
    try {
      localStorage.setItem('dm:onboarded', '1');
    } catch {
      /* sem armazenamento: o guia aparece de novo na próxima vez */
    }
    setShowOnboarding(false);
  };

  return (
    <div className="app">
      <Header
        auditorium={mixer.auditorium}
        onToggleAuditorium={() => {
          const on = !mixer.auditorium;
          mixer.setAuditorium(on);
          if (!on) mixer.setToneOn(false);
          setAnnounce(on ? 'Modo Auditório ligado: o som vai sair pelo PC' : 'Modo Auditório desligado');
        }}
        onSettings={() => setShowSettings(true)}
        onHelp={() => setShowOnboarding(true)}
      />

      <main className="app__main">
        <div className="app__top">
          <StatusBadge
            status={mixer.status}
            channelCount={mixer.channelCount}
            dualMono={mixer.dualMono}
            mode={mixer.mode}
            online={mixer.sources.filter((x) => x?.online).length}
            noSignal={mixer.noSignal}
          />
          {!ready && !['idle', 'requesting'].includes(mixer.status) && (
            <ProblemBanner status={mixer.status} onRetry={mixer.retry} />
          )}
        </div>

        {mixer.auditorium && <AuditoriumPanel mixer={mixer} />}

        {/* A mesa: corpo azul-ardósia com o friso creme do estojo. */}
        <div className="console">
          <div className="console__rail" aria-hidden="true">
            <span className="console__brand">DuoMix</span>
            <span className="console__device">{ready ? mixer.deviceLabel : 'sem receptor'}</span>
          </div>
          <div className="console__grid">
            {Array.from({ length: CHANNELS }, (_, i) => (
              <ChannelStrip
                key={i}
                index={i}
                cfg={channels[i]}
                meter={mixer.meters.ch[i]}
                floorDb={mixer.floors[i]}
                gateClosed={mixer.gates[i]}
                ready={ready}
                inactive={i >= mixer.channelCount || mixer.sources[i]?.online === false}
                dualMono={mixer.dualMono}
                source={mixer.sources[i]}
                mode={mixer.mode}
                paPaused={mixer.feedbackSafe}
                calibrating={mixer.calibrating}
                isolator={mixer.isolator}
                ducked={mixer.ducked[i]}
                duckedBy={channels.find((_, j) => j !== i && j < mixer.channelCount)?.name}
                mutedTalking={mixer.mutedTalking.ch[i]}
                onChange={(patch) => setChannel(i, patch)}
                onRetryIsolator={mixer.retryIsolator}
              />
            ))}
            <MasterStrip
              master={master}
              level={mixer.meters.master}
              limiting={mixer.meters.limiting}
              mutedTalking={mixer.mutedTalking.master}
              canAntiBleed={mixer.channelCount >= 2}
              auditorium={mixer.auditorium}
              ready={ready}
              calibrating={mixer.calibrating}
              autoMessage={autoMessage}
              onChange={setMaster}
              onAuto={handleAuto}
            />
          </div>
        </div>
      </main>

      <footer className="app__footer">
        DuoMix · criado por <strong>Arthur Macaúbas</strong> · © {new Date().getFullYear()}
      </footer>

      <p className="sr-only" aria-live="assertive">
        {announce}
      </p>

      {showSettings && (
        <SettingsPanel
          mixer={mixer}
          onClose={() => setShowSettings(false)}
          onRestartSetup={() => {
            setShowSettings(false);
            setShowOnboarding(true);
          }}
        />
      )}
      {showOnboarding && <Onboarding mixer={mixer} onDone={finishOnboarding} />}
    </div>
  );
}
