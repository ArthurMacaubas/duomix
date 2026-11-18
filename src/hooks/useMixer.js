import { useCallback, useEffect, useRef, useState } from 'react';
import { GtcrnWorkletNode, RnnoiseWorkletNode, loadGtcrn, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import gtcrnWorkletUrl from '@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url';
import gtcrnWasmUrl from '@sapphi-red/web-noise-suppressor/gtcrn.wasm?url';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

/*
 * useMixer: mesa de som de 2 canais para receptores de microfone duplo sem fio.
 *
 * Receptores duplos (TX1 + TX2) em modo estéreo mandam o microfone 1 no canal
 * esquerdo e o microfone 2 no direito. A mesa separa os dois e trata cada um:
 *
 *   receptor (estéreo) -> separador -> [canal 1] filtro de graves -> fader -> portão -> mudo -> medidor --\
 *                                   -> [canal 2] filtro de graves -> fader -> portão -> mudo -> medidor ---+-> master -> mudo geral -> medidor
 *                                                                                                                         \-> fone
 *
 * Em modo mono o receptor já mistura os dois: só o canal 1 recebe som.
 *
 * Depois do portão, cada canal ainda tem:
 *   - Nivelar voz: compressor que sobe quem fala baixo e segura quem grita.
 *   - Anti-vazamento: quando uma pessoa fala e a outra não, o microfone da outra
 *     abaixa 12 dB (ele só estaria captando a voz "vazada" de quem fala).
 * No master, um limitador impede a mistura de estourar.
 * Mesmo no mudo, o detector continua ouvindo para avisar "você está no mudo".
 *
 * Saída (Modo Auditório): master -> limitador -> mudo geral -> saída -> placa de som do PC
 * (P2 -> mesa do auditório). A saída sobe devagar ao ligar, para não estalar nas caixas,
 * e pode ir para outro aparelho (fone, HDMI...) com AudioContext.setSinkId.
 *
 * Isolador de voz (IA): entre o filtro de graves e o fader, cada canal pode passar por
 * um modelo de rede neural (GTCRN; RNNoise se o GTCRN não carregar) que separa a voz
 * do resto e tira o barulho até enquanto a pessoa fala. Ele só é baixado na primeira
 * vez que alguém liga o isolador, e exige áudio a 48 kHz.
 *
 * Limitação do navegador: tudo isso muda o som dentro do app (medidores e fone),
 * não o que outros programas recebem. Para isso o app precisa rodar como programa
 * de computador (Electron ou Tauri) com um dispositivo de áudio virtual.
 */

export const CHANNELS = 2;
// Rodando como app de computador (Electron)? O preload expõe window.duomix.
const IS_DESKTOP_APP = typeof window !== 'undefined' && window.duomix?.desktop === true;
const MIN_DB = -60;
const MAX_DB = -3;
const SILENCE_DB = -52;
const TARGET_DB = -20;
const CALIBRATION_MS = 5000;
const CLIP_HOLD_MS = 1500;

export const NOISE_LEVELS = ['off', 'leve', 'forte'];
const NOISE_PRESETS = {
  off: { highpass: 10, gate: false },
  leve: { highpass: 90, gate: false },
  forte: { highpass: 110, gate: true },
};
const GATE_MARGIN_DB = 9;
const GATE_FLOOR = Math.pow(10, -35 / 20);
const GATE_HOLD_MS = 300;

// Nivelar voz (compressor por canal) e limitador do master.
// O DynamicsCompressorNode já aplica um ganho de compensação automático (spec Web Audio:
// makeup = (1 / curva(0 dB))^0.6, uns +11 dB aqui). O "makeupDb" negativo desconta isso.
// Curva medida: -40 dB -> -37 | -20 dB -> -20 | -3 dB -> -15 (faixa de 37 dB vira 22 dB).
const LEVELER = { threshold: -26, knee: 10, ratio: 3.5, attack: 0.005, release: 0.25, makeupDb: -6 };
const LIMITER = { threshold: -3, knee: 0, ratio: 20, attack: 0.001, release: 0.1 };
// Anti-vazamento: quem fala precisa estar 6 dB acima do outro para o outro abaixar 12 dB.
const DUCK_DOMINANCE_DB = 6;
const DUCK_GAIN = Math.pow(10, -12 / 20);
const DUCK_HOLD_MS = 350;
// Aviso de mudo: fala por 0,6 s seguidos acima de -48 dB enquanto está no mudo.
const MUTED_TALK_MS = 600;
const MUTED_TALK_MIN_DB = -48;
const MUTED_TALK_CLEAR_MS = 1500;

// Modo Auditório
const OUTPUT_FADE_IN_S = 1.5; // subida suave da saída ao ligar
const TONE_HZ = 1000;
const TONE_AMP = Math.pow(10, -18 / 20) * Math.SQRT2; // tom de referência: -18 dBFS RMS
const TONE_MAX_MS = 60000; // desliga sozinho depois de 1 minuto
const ISOLATOR_LATENCY_MS = 16; // quadro de 768 amostras a 48 kHz

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dbToNorm = (db) => clamp((db - MIN_DB) / (MAX_DB - MIN_DB), 0, 1);
const rmsDb = (buf) => {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  return rms > 0 ? 20 * Math.log10(rms) : -120;
};
const peakOf = (buf) => {
  let p = 0;
  for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i]));
  return p;
};

/** Fader 0..100 -> ganho de -12 dB a +12 dB (50 = sem alteração). */
export const sliderToGain = (v) => Math.pow(10, (((v - 50) / 50) * 12) / 20);
export const gainToSlider = (g) => clamp(50 + ((20 * Math.log10(g)) / 12) * 50, 0, 100);
export const sliderToDb = (v) => ((v - 50) / 50) * 12;

function readStored(key, fallback) {
  try {
    const raw = localStorage.getItem(`dm:${key}`);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(`dm:${key}`, JSON.stringify(value));
  } catch {
    /* armazenamento indisponível: segue sem lembrar */
  }
}

function loadChannels() {
  const saved = readStored('channels', null);
  return Array.from({ length: CHANNELS }, (_, i) => {
    const s = saved?.[i] ?? {};
    return {
      name: typeof s.name === 'string' && s.name.trim() ? s.name : `Microfone ${i + 1}`,
      volume: Number.isFinite(s.volume) ? s.volume : 50,
      noise: NOISE_LEVELS.includes(s.noise) ? s.noise : 'leve',
      isolate: s.isolate === true,
      leveler: s.leveler !== false,
      muted: false,
    };
  });
}

function errorToStatus(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'denied';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'notfound';
    case 'NotReadableError':
    case 'AbortError':
      return 'busy';
    default:
      return 'error';
  }
}

const emptyMeters = () => ({
  ch: Array.from({ length: CHANNELS }, () => ({ level: 0, voice: 0, clip: false })),
  master: 0,
  limiting: false,
});

export function useMixer() {
  // idle | requesting | ready | denied | notfound | busy | disconnected | unsupported | error
  const [status, setStatus] = useState('idle');
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState(() => readStored('deviceId', ''));
  const [deviceLabel, setDeviceLabel] = useState('');
  const [sampleRate, setSampleRate] = useState(null);
  const [channelCount, setChannelCount] = useState(2);
  const [channels, setChannels] = useState(loadChannels);
  const [master, setMasterState] = useState(() => ({
    volume: readStored('masterVolume', 50),
    muted: false,
    monitor: false,
    antiBleed: readStored('antiBleed', true),
  }));
  // Modo Auditório: a mistura sai pela placa de som do PC para a mesa de som.
  const [auditorium, setAuditorium] = useState(() => readStored('auditorium', false));
  const [outputDevices, setOutputDevices] = useState([]);
  const [outputDeviceId, setOutputDeviceId] = useState(() => readStored('outputDeviceId', ''));
  const [sinkSupported] = useState(
    () => typeof AudioContext !== 'undefined' && typeof AudioContext.prototype.setSinkId === 'function',
  );
  const [toneOn, setToneOn] = useState(false);
  const [latencyMs, setLatencyMs] = useState(null);
  // idle | on | unsupported | error
  const [wakeLock, setWakeLock] = useState('idle');
  const [meters, setMeters] = useState(emptyMeters);
  const [floors, setFloors] = useState(() => new Array(CHANNELS).fill(-70));
  const [gates, setGates] = useState(() => new Array(CHANNELS).fill(false));
  const [ducked, setDucked] = useState(() => new Array(CHANNELS).fill(false));
  // Aviso "você está no mudo": por canal e para o mudo geral.
  const [mutedTalking, setMutedTalking] = useState(() => ({ ch: new Array(CHANNELS).fill(false), master: false }));
  const [calibrating, setCalibrating] = useState(false);
  // idle | loading | ready | error ; kind: 'gtcrn' | 'rnnoise'
  const [isolator, setIsolator] = useState({ status: 'idle', kind: null });

  const ctxRef = useRef(null);
  const isoLoadRef = useRef(null);
  const nodesRef = useRef(null);
  const sourceRef = useRef(null);
  const streamRef = useRef(null);
  const inputLatencyRef = useRef(0);
  const toneRef = useRef(null);
  const outputOnRef = useRef(false);
  const genRef = useRef(0);
  const calibRef = useRef(null);
  const statusRef = useRef(status);
  const channelsRef = useRef(channels);
  const channelCountRef = useRef(channelCount);
  const masterRef = useRef(master);
  const procRef = useRef(
    Array.from({ length: CHANNELS }, () => ({
      floor: -70,
      openUntil: 0,
      gateClosed: false,
      level: 0,
      voice: 0,
      lastLoud: 0,
      clipUntil: 0,
      speakingUntil: 0,
      ducked: false,
      duckUntil: 0,
      talkSince: 0,
      quietSince: 0,
      mutedTalking: false,
    })),
  );
  const masterTalkRef = useRef(false);
  const masterProcRef = useRef({ level: 0 });

  statusRef.current = status;
  channelsRef.current = channels;
  channelCountRef.current = channelCount;
  masterRef.current = master;

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const list = await navigator.mediaDevices.enumerateDevices();
    const inputs = list
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Receptor ${i + 1}` }));
    setDevices(inputs);
    setOutputDevices(
      list
        .filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Saída ${i + 1}` })),
    );
    return inputs;
  }, []);

  const stopStream = useCallback(() => {
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    streamRef.current?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    streamRef.current = null;
  }, []);

  const ensureGraph = useCallback(() => {
    if (ctxRef.current) return ctxRef.current;
    // 48 kHz: é a taxa que os modelos de isolamento de voz esperam.
    let ctx;
    // latencyHint "interactive": o menor atraso que o navegador consegue (importante ao vivo).
    try {
      ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    } catch {
      ctx = new AudioContext({ latencyHint: 'interactive' });
    }
    const splitter = ctx.createChannelSplitter(CHANNELS);
    const sum = ctx.createGain();
    const masterGain = ctx.createGain();
    const masterMute = ctx.createGain();
    const out = ctx.createGain();
    out.gain.value = 0;
    const masterAnalyser = ctx.createAnalyser();
    masterAnalyser.fftSize = 2048;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = LIMITER.threshold;
    limiter.knee.value = LIMITER.knee;
    limiter.ratio.value = LIMITER.ratio;
    limiter.attack.value = LIMITER.attack;
    limiter.release.value = LIMITER.release;

    const ch = channelsRef.current.map((c, i) => {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.Q.value = 0.7;
      hp.frequency.value = NOISE_PRESETS[c.noise].highpass;
      const fader = ctx.createGain();
      fader.gain.value = sliderToGain(c.volume);
      const detector = ctx.createAnalyser();
      detector.fftSize = 1024;
      const gate = ctx.createGain();
      const comp = ctx.createDynamicsCompressor();
      const makeup = ctx.createGain();
      const duck = ctx.createGain();
      const mute = ctx.createGain();
      mute.gain.value = c.muted ? 0 : 1;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;

      // Dois caminhos até o fader: direto (dry) ou pelo isolador de voz (wet).
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      wet.gain.value = 0;

      splitter.connect(hp, i);
      hp.connect(dry);
      dry.connect(fader);
      wet.connect(fader);
      fader.connect(detector);
      fader.connect(gate);
      gate.connect(comp);
      comp.connect(makeup);
      makeup.connect(duck);
      duck.connect(mute);
      mute.connect(analyser);
      mute.connect(sum);
      return { hp, dry, wet, iso: null, fader, detector, gate, comp, makeup, duck, mute, analyser };
    });

    sum.connect(masterGain);
    masterGain.connect(limiter);
    limiter.connect(masterMute);
    masterMute.connect(masterAnalyser);
    masterMute.connect(out);
    out.connect(ctx.destination);

    ctxRef.current = ctx;
    nodesRef.current = { splitter, ch, sum, masterGain, limiter, masterMute, masterAnalyser, out };
    outputOnRef.current = false;
    toneRef.current = null;
    setSampleRate(ctx.sampleRate);
    return ctx;
  }, []);

  /** Baixa o modelo de IA (uma vez só) e liga um isolador em cada canal. */
  const ensureIsolator = useCallback(() => {
    if (isoLoadRef.current) return isoLoadRef.current;
    const ctx = ctxRef.current;
    const nodes = nodesRef.current;
    if (!ctx || !nodes) return Promise.resolve(false);
    if (ctx.sampleRate !== 48000 || !ctx.audioWorklet) {
      setIsolator({ status: 'error', kind: null });
      return Promise.resolve(false);
    }

    setIsolator({ status: 'loading', kind: null });
    const attach = (makeNode) => {
      nodes.ch.forEach((n) => {
        n.iso = makeNode();
        n.hp.connect(n.iso);
        n.iso.connect(n.wet);
      });
    };

    const job = (async () => {
      try {
        const wasm = await loadGtcrn({ url: gtcrnWasmUrl });
        await ctx.audioWorklet.addModule(gtcrnWorkletUrl);
        if (ctxRef.current !== ctx) return false;
        attach(() => new GtcrnWorkletNode(ctx, { maxChannels: 1, wasmBinary: wasm }));
        setIsolator({ status: 'ready', kind: 'gtcrn' });
        return true;
      } catch (err) {
        if (ctxRef.current !== ctx) return false; // a mesa foi fechada no meio do carregamento
        console.warn('GTCRN indisponível, usando RNNoise.', err);
      }
      try {
        const wasm = await loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl });
        await ctx.audioWorklet.addModule(rnnoiseWorkletUrl);
        if (ctxRef.current !== ctx) return false;
        attach(() => new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: wasm }));
        setIsolator({ status: 'ready', kind: 'rnnoise' });
        return true;
      } catch (err) {
        if (ctxRef.current !== ctx) return false;
        console.error('Isolador de voz indisponível.', err);
        setIsolator({ status: 'error', kind: null });
        isoLoadRef.current = null; // permite tentar de novo
        return false;
      }
    })();
    isoLoadRef.current = job;
    return job;
  }, []);

  const start = useCallback(
    async (id = deviceId) => {
      if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined') {
        setStatus('unsupported');
        return;
      }
      const gen = ++genRef.current;
      if (statusRef.current !== 'ready') setStatus('requesting');

      // Processamentos do navegador desligados: eles juntam o som em mono
      // e impediriam de separar os dois microfones.
      const constraints = (withId) => ({
        audio: {
          ...(withId && id ? { deviceId: { exact: id } } : {}),
          channelCount: { ideal: 2 },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints(true));
      } catch (err) {
        if (id && (err?.name === 'OverconstrainedError' || err?.name === 'NotFoundError')) {
          try {
            stream = await navigator.mediaDevices.getUserMedia(constraints(false));
          } catch (err2) {
            if (gen === genRef.current) setStatus(errorToStatus(err2));
            return;
          }
        } else {
          if (gen === genRef.current) setStatus(errorToStatus(err));
          return;
        }
      }

      if (gen !== genRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      stopStream();
      const ctx = ensureGraph();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});

      const track = stream.getAudioTracks()[0];
      track.onended = () => {
        if (streamRef.current === stream) setStatus('disconnected');
      };

      const source = ctx.createMediaStreamSource(stream);
      source.connect(nodesRef.current.splitter);
      sourceRef.current = source;
      streamRef.current = stream;

      const settings = track.getSettings?.() ?? {};
      inputLatencyRef.current = Number.isFinite(settings.latency) ? settings.latency : 0;
      setChannelCount(settings.channelCount === 1 ? 1 : 2);
      setDeviceLabel(track.label || 'Receptor');
      if (settings.deviceId) setDeviceId(settings.deviceId);
      setStatus('ready');
      refreshDevices();
    },
    [deviceId, ensureGraph, refreshDevices, stopStream],
  );

  // Liga a mesa ao abrir o app e desliga tudo ao fechar.
  useEffect(() => {
    start();
    return () => {
      genRef.current++;
      stopStream();
      nodesRef.current?.ch.forEach((n) => n.iso?.destroy?.());
      try {
        toneRef.current?.osc.stop();
      } catch {
        /* já parado */
      }
      ctxRef.current?.close().catch(() => {});
      ctxRef.current = null;
      nodesRef.current = null;
      isoLoadRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Portões, anti-vazamento, aviso de mudo e calibração: loop próprio de 30 ms, separado da tela.
  // No navegador, com a janela escondida, portões e anti-vazamento ficam soltos: na dúvida, a voz passa.
  useEffect(() => {
    const buf = new Float32Array(1024);
    let ticks = 0;

    const setGate = (i, closed) => {
      const p = procRef.current[i];
      const node = nodesRef.current?.ch[i]?.gate;
      if (closed === p.gateClosed || !node || !ctxRef.current) return;
      node.gain.setTargetAtTime(closed ? GATE_FLOOR : 1, ctxRef.current.currentTime, closed ? 0.08 : 0.005);
      p.gateClosed = closed;
      setGates((g) => g.map((v, j) => (j === i ? closed : v)));
    };

    const setDuck = (i, on) => {
      const p = procRef.current[i];
      const node = nodesRef.current?.ch[i]?.duck;
      if (on === p.ducked || !node || !ctxRef.current) return;
      node.gain.setTargetAtTime(on ? DUCK_GAIN : 1, ctxRef.current.currentTime, on ? 0.02 : 0.25);
      p.ducked = on;
      setDucked((d) => d.map((v, j) => (j === i ? on : v)));
    };

    let lastTalk = { ch: new Array(CHANNELS).fill(false), master: false };
    const pre = new Array(CHANNELS).fill(-120);

    const process = () => {
      const nodes = nodesRef.current;
      if (!nodes || !streamRef.current) return;
      const now = performance.now();
      const active = channelCountRef.current;
      // No app de computador o processamento continua mesmo minimizado (sem congelamento).
      if (document.hidden && !IS_DESKTOP_APP) {
        for (let i = 0; i < CHANNELS; i++) {
          setGate(i, false);
          setDuck(i, false);
        }
        return;
      }
      for (let i = 0; i < CHANNELS; i++) {
        const p = procRef.current[i];
        const cfg = channelsRef.current[i];
        nodes.ch[i].detector.getFloatTimeDomainData(buf);
        const preDb = rmsDb(buf);
        if (!cfg.muted) {
          // Desce rápido no silêncio; sobe devagar com barulho; quase não aprende durante a fala
          // (senão a voz vira "barulho do ambiente").
          const speaking = preDb > p.floor + GATE_MARGIN_DB;
          const rate = preDb < p.floor ? 0.25 : speaking ? 0.0004 : 0.004;
          p.floor = clamp(p.floor + (preDb - p.floor) * rate, -90, -30);
        }
        if (preDb > p.floor + GATE_MARGIN_DB) p.openUntil = now + GATE_HOLD_MS;
        setGate(i, NOISE_PRESETS[cfg.noise].gate && !cfg.muted && now > p.openUntil);

        if (calibRef.current && !cfg.muted && preDb > SILENCE_DB) {
          calibRef.current[i].push(preDb - 20 * Math.log10(sliderToGain(cfg.volume)));
        }

        pre[i] = preDb;
        if (preDb > p.floor + GATE_MARGIN_DB && preDb > SILENCE_DB) p.speakingUntil = now + DUCK_HOLD_MS;

        // Fala contínua (para o aviso de mudo), com folga para pausas entre palavras.
        const talking = preDb > Math.max(p.floor + GATE_MARGIN_DB, MUTED_TALK_MIN_DB);
        if (talking) {
          if (!p.talkSince) p.talkSince = now;
          p.quietSince = 0;
          if (now - p.talkSince >= MUTED_TALK_MS) p.mutedTalking = true;
        } else {
          p.talkSince = 0;
          if (!p.quietSince) p.quietSince = now;
          if (now - p.quietSince >= MUTED_TALK_CLEAR_MS) p.mutedTalking = false;
        }
      }

      // Quem domina: outro canal falando e pelo menos 6 dB mais alto que este.
      const dominatedBy = (i) => {
        for (let j = 0; j < active; j++) {
          if (j === i || channelsRef.current[j].muted) continue;
          if (now < procRef.current[j].speakingUntil && pre[j] - pre[i] > DUCK_DOMINANCE_DB) return true;
        }
        return false;
      };

      // Anti-vazamento: abaixa o microfone de quem só está captando a voz do outro.
      for (let i = 0; i < CHANNELS; i++) {
        const p = procRef.current[i];
        if (masterRef.current.antiBleed && active >= 2 && i < active && dominatedBy(i)) {
          p.duckUntil = now + DUCK_HOLD_MS;
        }
        setDuck(i, now < p.duckUntil && masterRef.current.antiBleed);
      }

      // Aviso "você está no mudo": ignora a voz vazada de quem está falando no outro microfone.
      const talkCh = procRef.current.map((p, i) => i < active && p.mutedTalking && !dominatedBy(i));
      const next = {
        ch: talkCh.map((t, i) => t && channelsRef.current[i].muted),
        master: masterRef.current.muted && talkCh.some((t, i) => t && !channelsRef.current[i].muted),
      };
      if (next.master !== lastTalk.master || next.ch.some((v, i) => v !== lastTalk.ch[i])) {
        lastTalk = next;
        setMutedTalking(next);
      }

      if (++ticks % 30 === 0) setFloors(procRef.current.map((p) => Math.round(p.floor)));
    };

    const id = setInterval(process, 30);
    return () => clearInterval(id);
  }, []);

  // Medidores na tela (~30 quadros/s).
  useEffect(() => {
    const buf = new Float32Array(2048);
    let frame = 0;
    let raf = 0;

    const smooth = (cur, target) => cur + (target - cur) * (target > cur ? 0.6 : 0.18);

    const tick = (now) => {
      raf = requestAnimationFrame(tick);
      const nodes = nodesRef.current;
      if (!nodes || !streamRef.current) return;
      if (++frame % 2) return;

      const ch = nodes.ch.map((n, i) => {
        const p = procRef.current[i];
        n.analyser.getFloatTimeDomainData(buf);
        const target = dbToNorm(rmsDb(buf));
        if (peakOf(buf) > 0.98) p.clipUntil = now + CLIP_HOLD_MS;
        p.level = smooth(p.level, target);
        if (target > 0.15) p.lastLoud = now;
        if (target > p.voice) p.voice += (target - p.voice) * 0.35;
        else if (now - p.lastLoud > 1200) p.voice *= 0.95;
        return { level: p.level, voice: p.voice, clip: now < p.clipUntil };
      });

      nodes.masterAnalyser.getFloatTimeDomainData(buf);
      const m = masterProcRef.current;
      m.level = smooth(m.level, dbToNorm(rmsDb(buf)));
      // reduction: quantos dB o limitador está segurando agora.
      if (nodes.limiter.reduction < -1) m.limitUntil = now + 800;

      setMeters({ ch, master: m.level, limiting: now < (m.limitUntil ?? 0) });
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // O Chrome pausa o áudio até a pessoa interagir com a página: retoma no primeiro clique/tecla.
  useEffect(() => {
    const resume = () => {
      if (ctxRef.current?.state === 'suspended') ctxRef.current.resume().catch(() => {});
    };
    window.addEventListener('pointerdown', resume, true);
    window.addEventListener('keydown', resume, true);
    return () => {
      window.removeEventListener('pointerdown', resume, true);
      window.removeEventListener('keydown', resume, true);
    };
  }, []);

  // Aplica fader, mudo e filtro de cada canal.
  useEffect(() => {
    const nodes = nodesRef.current;
    const ctx = ctxRef.current;
    if (nodes && ctx) {
      channels.forEach((c, i) => {
        const n = nodes.ch[i];
        n.fader.gain.setTargetAtTime(sliderToGain(c.volume), ctx.currentTime, 0.03);
        n.mute.gain.setTargetAtTime(c.muted ? 0 : 1, ctx.currentTime, 0.01);
        n.hp.frequency.setTargetAtTime(NOISE_PRESETS[c.noise].highpass, ctx.currentTime, 0.05);
        // Nivelar voz: compressor ligado, ou neutro (ratio 1 = não mexe no som).
        const lv = c.leveler;
        n.comp.threshold.setTargetAtTime(lv ? LEVELER.threshold : 0, ctx.currentTime, 0.05);
        n.comp.knee.setTargetAtTime(lv ? LEVELER.knee : 0, ctx.currentTime, 0.05);
        n.comp.ratio.setTargetAtTime(lv ? LEVELER.ratio : 1, ctx.currentTime, 0.05);
        n.comp.attack.value = LEVELER.attack;
        n.comp.release.value = LEVELER.release;
        n.makeup.gain.setTargetAtTime(lv ? Math.pow(10, LEVELER.makeupDb / 20) : 1, ctx.currentTime, 0.05);
        // Isolador: troca suave entre o caminho direto e o caminho pela IA.
        const useIso = c.isolate && !!n.iso;
        n.wet.gain.setTargetAtTime(useIso ? 1 : 0, ctx.currentTime, 0.03);
        n.dry.gain.setTargetAtTime(useIso ? 0 : 1, ctx.currentTime, 0.03);
      });
      if (channels.some((c) => c.isolate) && isolator.status === 'idle') ensureIsolator();
    }
    writeStored(
      'channels',
      channels.map(({ name, volume, noise, isolate, leveler }) => ({ name, volume, noise, isolate, leveler })),
    );
  }, [channels, isolator.status, status, ensureIsolator]);

  // Aplica master e a saída (fone ou Modo Auditório).
  const outputOn = auditorium || master.monitor;
  useEffect(() => {
    const nodes = nodesRef.current;
    const ctx = ctxRef.current;
    if (nodes && ctx) {
      nodes.masterGain.gain.setTargetAtTime(sliderToGain(master.volume), ctx.currentTime, 0.03);
      nodes.masterMute.gain.setTargetAtTime(master.muted ? 0 : 1, ctx.currentTime, 0.01);
      if (outputOn !== outputOnRef.current) {
        const g = nodes.out.gain;
        const t = ctx.currentTime;
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
        // Liga subindo devagar (sem estalo nas caixas); desliga rápido.
        g.linearRampToValueAtTime(outputOn ? 1 : 0, t + (outputOn ? (auditorium ? OUTPUT_FADE_IN_S : 0.15) : 0.1));
        outputOnRef.current = outputOn;
      }
    }
    writeStored('masterVolume', master.volume);
    writeStored('antiBleed', master.antiBleed);
  }, [master, status, outputOn, auditorium]);

  useEffect(() => {
    writeStored('auditorium', auditorium);
  }, [auditorium]);

  // Para qual aparelho o som sai (P2/fone, HDMI...). '' = saída padrão do Windows.
  useEffect(() => {
    writeStored('outputDeviceId', outputDeviceId);
    const ctx = ctxRef.current;
    if (!ctx || !sinkSupported) return;
    ctx.setSinkId(outputDeviceId).catch((err) => {
      console.warn('Não consegui trocar a saída de áudio.', err);
      setOutputDeviceId('');
    });
  }, [outputDeviceId, status, sinkSupported]);

  // Atraso estimado dentro do PC: entrada + processamento + saída (+ isolador, se ligado).
  const anyIsolate = channels.some((c) => c.isolate) && isolator.status === 'ready';
  useEffect(() => {
    const read = () => {
      const ctx = ctxRef.current;
      if (!ctx || statusRef.current !== 'ready') return setLatencyMs(null);
      const sec = (ctx.baseLatency || 0) + (ctx.outputLatency || 0) + inputLatencyRef.current;
      setLatencyMs(Math.round(sec * 1000 + (anyIsolate ? ISOLATOR_LATENCY_MS : 0)));
    };
    read();
    const id = setInterval(read, 2000);
    return () => clearInterval(id);
  }, [status, anyIsolate]);

  // Tela sempre ligada no Modo Auditório (o PC não pode dormir no meio do evento).
  useEffect(() => {
    if (!auditorium) {
      setWakeLock('idle');
      return;
    }
    if (!('wakeLock' in navigator)) {
      setWakeLock('unsupported');
      return;
    }
    let lock = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        lock = await navigator.wakeLock.request('screen');
        if (cancelled) lock.release().catch(() => {});
        else setWakeLock('on');
        lock.addEventListener?.('release', () => !cancelled && setWakeLock('idle'));
      } catch {
        if (!cancelled) setWakeLock('error');
      }
    };
    // O navegador solta a trava quando a aba fica escondida: pega de novo ao voltar.
    const onVisible = () => document.visibilityState === 'visible' && acquire();
    acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      lock?.release().catch(() => {});
    };
  }, [auditorium]);

  /** Tom de teste de 1 kHz (-18 dBFS) direto na saída, para o técnico acertar o volume na mesa. */
  const setTone = useCallback((on) => {
    const ctx = ctxRef.current;
    const nodes = nodesRef.current;
    if (!ctx || !nodes) return;
    if (on && !toneRef.current) {
      const osc = ctx.createOscillator();
      osc.frequency.value = TONE_HZ;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(TONE_AMP, ctx.currentTime + 0.3);
      osc.connect(gain);
      gain.connect(nodes.out);
      osc.start();
      const timer = setTimeout(() => setToneOn(false), TONE_MAX_MS);
      toneRef.current = { osc, gain, timer };
    } else if (!on && toneRef.current) {
      const { osc, gain, timer } = toneRef.current;
      clearTimeout(timer);
      gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      osc.stop(ctx.currentTime + 0.3);
      toneRef.current = null;
    }
  }, []);

  useEffect(() => {
    setTone(toneOn);
  }, [toneOn, setTone]);

  useEffect(() => {
    writeStored('deviceId', deviceId);
  }, [deviceId]);

  // Plugou ou tirou o receptor: atualiza a lista e reconecta sozinho se preciso.
  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md?.addEventListener) return;
    const onChange = async () => {
      const inputs = await refreshDevices();
      if (['disconnected', 'notfound', 'busy'].includes(statusRef.current) && inputs.length > 0) {
        start('');
      }
    };
    md.addEventListener('devicechange', onChange);
    return () => md.removeEventListener('devicechange', onChange);
  }, [refreshDevices, start]);

  const chooseDevice = useCallback(
    (id) => {
      setDeviceId(id);
      start(id);
    },
    [start],
  );

  const setChannel = useCallback((i, patch) => {
    setChannels((list) => list.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  }, []);

  const setMaster = useCallback((patch) => setMasterState((m) => ({ ...m, ...patch })), []);

  /** Escuta 5 s e acerta o fader de cada canal para a voz ficar na faixa ideal. */
  const autoAdjust = useCallback(() => {
    if (calibRef.current || statusRef.current !== 'ready') {
      return Promise.resolve({ ok: false, results: [] });
    }
    setChannels((list) => list.map((c) => ({ ...c, muted: false })));
    setMasterState((m) => ({ ...m, muted: false }));
    setCalibrating(true);
    calibRef.current = Array.from({ length: CHANNELS }, () => []);
    return new Promise((resolve) => {
      setTimeout(() => {
        const samples = calibRef.current ?? [];
        calibRef.current = null;
        setCalibrating(false);
        const active = channelCountRef.current;
        const results = samples.map((s, i) => {
          if (i >= active) return 'mono';
          if (s.length < 20) return 'silent';
          s.sort((a, b) => a - b);
          const p90 = s[Math.floor(s.length * 0.9)];
          return Math.round(gainToSlider(clamp(Math.pow(10, (TARGET_DB - p90) / 20), 0.25, 3.98)));
        });
        setChannels((list) => list.map((c, i) => (typeof results[i] === 'number' ? { ...c, volume: results[i] } : c)));
        resolve({ ok: results.some((r) => typeof r === 'number'), results });
      }, CALIBRATION_MS);
    });
  }, []);

  return {
    status,
    devices,
    deviceId,
    deviceLabel,
    sampleRate,
    channelCount,
    channels,
    master,
    meters,
    floors,
    gates,
    ducked,
    mutedTalking,
    calibrating,
    calibrationMs: CALIBRATION_MS,
    isolator,
    retryIsolator: () => {
      setIsolator({ status: 'idle', kind: null });
    },
    retry: () => start(deviceId),
    auditorium,
    setAuditorium,
    outputOn,
    outputDevices,
    outputDeviceId,
    setOutputDeviceId,
    sinkSupported,
    toneOn,
    setToneOn,
    latencyMs,
    wakeLock,
    chooseDevice,
    setChannel,
    setMaster,
    autoAdjust,
  };
}
