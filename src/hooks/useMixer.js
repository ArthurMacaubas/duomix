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
  }));
  const [meters, setMeters] = useState(emptyMeters);
  const [floors, setFloors] = useState(() => new Array(CHANNELS).fill(-70));
  const [gates, setGates] = useState(() => new Array(CHANNELS).fill(false));
  const [calibrating, setCalibrating] = useState(false);
  // idle | loading | ready | error ; kind: 'gtcrn' | 'rnnoise'
  const [isolator, setIsolator] = useState({ status: 'idle', kind: null });

  const ctxRef = useRef(null);
  const isoLoadRef = useRef(null);
  const nodesRef = useRef(null);
  const sourceRef = useRef(null);
  const streamRef = useRef(null);
  const monitorOnRef = useRef(false);
  const genRef = useRef(0);
  const calibRef = useRef(null);
  const statusRef = useRef(status);
  const channelsRef = useRef(channels);
  const channelCountRef = useRef(channelCount);
  const procRef = useRef(
    Array.from({ length: CHANNELS }, () => ({
      floor: -70,
      openUntil: 0,
      gateClosed: false,
      level: 0,
      voice: 0,
      lastLoud: 0,
      clipUntil: 0,
    })),
  );
  const masterProcRef = useRef({ level: 0 });

  statusRef.current = status;
  channelsRef.current = channels;
  channelCountRef.current = channelCount;

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const list = await navigator.mediaDevices.enumerateDevices();
    const inputs = list
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Receptor ${i + 1}` }));
    setDevices(inputs);
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
    try {
      ctx = new AudioContext({ sampleRate: 48000 });
    } catch {
      ctx = new AudioContext();
    }
    const splitter = ctx.createChannelSplitter(CHANNELS);
    const sum = ctx.createGain();
    const masterGain = ctx.createGain();
    const masterMute = ctx.createGain();
    const masterAnalyser = ctx.createAnalyser();
    masterAnalyser.fftSize = 2048;

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
      gate.connect(mute);
      mute.connect(analyser);
      mute.connect(sum);
      return { hp, dry, wet, iso: null, fader, detector, gate, mute, analyser };
    });

    sum.connect(masterGain);
    masterGain.connect(masterMute);
    masterMute.connect(masterAnalyser);

    ctxRef.current = ctx;
    nodesRef.current = { splitter, ch, sum, masterGain, masterMute, masterAnalyser };
    monitorOnRef.current = false;
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
      ctxRef.current?.close().catch(() => {});
      ctxRef.current = null;
      nodesRef.current = null;
      isoLoadRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Portões de ruído e calibração: loop próprio de 30 ms, separado da tela.
  // Com a janela escondida os portões ficam abertos: na dúvida, a voz passa.
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

    const process = () => {
      const nodes = nodesRef.current;
      if (!nodes || !streamRef.current) return;
      const now = performance.now();
      for (let i = 0; i < CHANNELS; i++) {
        const p = procRef.current[i];
        const cfg = channelsRef.current[i];
        if (document.hidden) {
          setGate(i, false);
          continue;
        }
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

      setMeters({ ch, master: m.level });
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
        // Isolador: troca suave entre o caminho direto e o caminho pela IA.
        const useIso = c.isolate && !!n.iso;
        n.wet.gain.setTargetAtTime(useIso ? 1 : 0, ctx.currentTime, 0.03);
        n.dry.gain.setTargetAtTime(useIso ? 0 : 1, ctx.currentTime, 0.03);
      });
      if (channels.some((c) => c.isolate) && isolator.status === 'idle') ensureIsolator();
    }
    writeStored(
      'channels',
      channels.map(({ name, volume, noise, isolate }) => ({ name, volume, noise, isolate })),
    );
  }, [channels, isolator.status, status, ensureIsolator]);

  // Aplica master e "Me ouvir no fone".
  useEffect(() => {
    const nodes = nodesRef.current;
    const ctx = ctxRef.current;
    if (nodes && ctx) {
      nodes.masterGain.gain.setTargetAtTime(sliderToGain(master.volume), ctx.currentTime, 0.03);
      nodes.masterMute.gain.setTargetAtTime(master.muted ? 0 : 1, ctx.currentTime, 0.01);
      if (master.monitor && !monitorOnRef.current) {
        nodes.masterMute.connect(ctx.destination);
        monitorOnRef.current = true;
      } else if (!master.monitor && monitorOnRef.current) {
        nodes.masterMute.disconnect(ctx.destination);
        monitorOnRef.current = false;
      }
    }
    writeStored('masterVolume', master.volume);
  }, [master, status]);

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
    calibrating,
    calibrationMs: CALIBRATION_MS,
    isolator,
    retryIsolator: () => {
      setIsolator({ status: 'idle', kind: null });
    },
    retry: () => start(deviceId),
    chooseDevice,
    setChannel,
    setMaster,
    autoAdjust,
  };
}
