import { useCallback, useEffect, useRef, useState } from 'react';

/*
 * useMicrophone: toda a parte de áudio do app, via Web Audio API.
 *
 * Cadeia de áudio:
 *   microfone -> filtro de graves (tira ronco) -> volume da voz -> portão de ruído -> medidor
 *                                                      |                  \-> fone ("Me ouvir no fone")
 *                                                      \-> detector (decide quando abrir o portão)
 *
 * Redutor de ruído em 3 níveis:
 *   off   : nada é filtrado.
 *   leve  : filtro de graves + supressão de ruído do navegador.
 *   forte : tudo do leve + portão de ruído, que abaixa o som quando você não está falando.
 *
 * Limitação do navegador: tudo isso altera o som dentro do app (medidor e fone),
 * não o que outros programas (Discord, Zoom) recebem. Para isso o app precisa
 * rodar empacotado em Electron ou Tauri, com um dispositivo de áudio virtual.
 */

const MIN_DB = -60;
const MAX_DB = -6;
const SILENCE_DB = -52;
const TARGET_DB = -20;
const CALIBRATION_MS = 5000;
export const BAND_COUNT = 8;

export const NOISE_LEVELS = ['off', 'leve', 'forte'];
const NOISE_PRESETS = {
  off: { highpass: 10, browserNs: false, gate: false },
  leve: { highpass: 80, browserNs: true, gate: false },
  forte: { highpass: 100, browserNs: true, gate: true },
};
const GATE_MARGIN_DB = 9; // quanto acima do barulho de fundo a voz precisa estar
const GATE_FLOOR = Math.pow(10, -35 / 20); // portão fechado: -35 dB
const GATE_HOLD_MS = 300;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dbToNorm = (db) => clamp((db - MIN_DB) / (MAX_DB - MIN_DB), 0, 1);
const rmsDb = (buf) => {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  return rms > 0 ? 20 * Math.log10(rms) : -120;
};

/** Slider 0..100 -> ganho de -12 dB a +12 dB (50 = sem alteração). */
export const sliderToGain = (v) => Math.pow(10, (((v - 50) / 50) * 12) / 20);
export const gainToSlider = (g) => clamp(50 + ((20 * Math.log10(g)) / 12) * 50, 0, 100);

function readStored(key, fallback) {
  try {
    const raw = localStorage.getItem(`mm:${key}`);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(`mm:${key}`, JSON.stringify(value));
  } catch {
    /* armazenamento indisponível: segue sem lembrar */
  }
}

function readNoiseLevel() {
  const saved = readStored('noiseLevel', null);
  if (NOISE_LEVELS.includes(saved)) return saved;
  // Versão anterior guardava só ligado/desligado.
  return readStored('noiseSuppression', true) ? 'leve' : 'off';
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

export function useMicrophone() {
  // idle | requesting | ready | denied | notfound | busy | disconnected | unsupported | error
  const [status, setStatus] = useState('idle');
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState(() => readStored('deviceId', ''));
  const [deviceLabel, setDeviceLabel] = useState('');
  const [sampleRate, setSampleRate] = useState(null);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(() => readStored('volume', 50));
  const [monitor, setMonitor] = useState(false);
  const [noiseLevel, setNoiseLevel] = useState(readNoiseLevel);
  const [level, setLevel] = useState(0);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [bands, setBands] = useState(() => new Array(BAND_COUNT).fill(0));
  const [noiseFloorDb, setNoiseFloorDb] = useState(-70);
  const [gateClosed, setGateClosed] = useState(false);
  const [calibrating, setCalibrating] = useState(false);

  const ctxRef = useRef(null);
  const highpassRef = useRef(null);
  const gainRef = useRef(null);
  const detectorRef = useRef(null);
  const gateRef = useRef(null);
  const analyserRef = useRef(null);
  const sourceRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(0);
  const genRef = useRef(0);
  const calibRef = useRef(null);
  const statusRef = useRef(status);
  const mutedRef = useRef(muted);
  const volumeRef = useRef(volume);
  const monitorRef = useRef(monitor);
  const noiseRef = useRef(noiseLevel);
  const meterRef = useRef({ level: 0, voice: 0, lastLoud: 0, frame: 0, floor: -70, gateOpenUntil: 0, gateClosed: false });

  statusRef.current = status;
  mutedRef.current = muted;
  volumeRef.current = volume;
  monitorRef.current = monitor;
  noiseRef.current = noiseLevel;

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const list = await navigator.mediaDevices.enumerateDevices();
    const inputs = list
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Microfone ${i + 1}` }));
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
    const ctx = new AudioContext();
    const preset = NOISE_PRESETS[noiseRef.current];

    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = preset.highpass;
    highpass.Q.value = 0.7;

    const gain = ctx.createGain();
    gain.gain.value = sliderToGain(volumeRef.current);

    const detector = ctx.createAnalyser();
    detector.fftSize = 1024;

    const gate = ctx.createGain();

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.6;

    highpass.connect(gain);
    gain.connect(detector);
    gain.connect(gate);
    gate.connect(analyser);
    if (monitorRef.current) gate.connect(ctx.destination);

    ctxRef.current = ctx;
    highpassRef.current = highpass;
    gainRef.current = gain;
    detectorRef.current = detector;
    gateRef.current = gate;
    analyserRef.current = analyser;
    setSampleRate(ctx.sampleRate);
    return ctx;
  }, []);

  const start = useCallback(
    async (id = deviceId) => {
      if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined') {
        setStatus('unsupported');
        return;
      }
      const gen = ++genRef.current;
      if (statusRef.current !== 'ready') setStatus('requesting');

      const constraints = (withId) => ({
        audio: {
          ...(withId && id ? { deviceId: { exact: id } } : {}),
          noiseSuppression: NOISE_PRESETS[noiseRef.current].browserNs,
          echoCancellation: false,
          autoGainControl: false,
        },
      });

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints(true));
      } catch (err) {
        // O microfone salvo sumiu? Tenta o padrão do sistema antes de desistir.
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
      track.enabled = !mutedRef.current;
      track.onended = () => {
        if (streamRef.current === stream) setStatus('disconnected');
      };

      const source = ctx.createMediaStreamSource(stream);
      source.connect(highpassRef.current);
      sourceRef.current = source;
      streamRef.current = stream;

      const settings = track.getSettings?.() ?? {};
      setDeviceLabel(track.label || 'Microfone');
      if (settings.deviceId) setDeviceId(settings.deviceId);
      setStatus('ready');
      refreshDevices();
    },
    [deviceId, ensureGraph, refreshDevices, stopStream],
  );

  // Liga o microfone ao abrir o app e desliga tudo ao fechar.
  useEffect(() => {
    start();
    return () => {
      genRef.current++;
      stopStream();
      ctxRef.current?.close().catch(() => {});
      ctxRef.current = null;
      highpassRef.current = null;
      gainRef.current = null;
      detectorRef.current = null;
      gateRef.current = null;
      analyserRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Portão de ruído e calibração: loop próprio (a cada 30 ms), separado da tela.
  // Ele não depende de requestAnimationFrame, que o navegador congela quando a janela
  // fica escondida. Com a janela escondida o portão fica aberto: na dúvida, a voz passa.
  useEffect(() => {
    const detBuf = new Float32Array(1024);
    let ticks = 0;

    const setGate = (closed) => {
      const m = meterRef.current;
      if (closed === m.gateClosed || !gateRef.current || !ctxRef.current) return;
      gateRef.current.gain.setTargetAtTime(closed ? GATE_FLOOR : 1, ctxRef.current.currentTime, closed ? 0.08 : 0.005);
      m.gateClosed = closed;
      setGateClosed(closed);
    };

    const process = () => {
      const detector = detectorRef.current;
      const m = meterRef.current;
      if (!detector || !streamRef.current) return;
      if (document.hidden) {
        setGate(false);
        return;
      }
      const now = performance.now();
      detector.getFloatTimeDomainData(detBuf);
      const preDb = rmsDb(detBuf);

      if (!mutedRef.current) {
        // Desce rápido quando fica silêncio, sobe bem devagar (a voz não "vira" barulho).
        m.floor += (preDb - m.floor) * (preDb < m.floor ? 0.25 : 0.004);
        m.floor = clamp(m.floor, -90, -30);
      }
      if (preDb > m.floor + GATE_MARGIN_DB) m.gateOpenUntil = now + GATE_HOLD_MS;
      setGate(NOISE_PRESETS[noiseRef.current].gate && !mutedRef.current && now > m.gateOpenUntil);

      if (calibRef.current && !mutedRef.current && preDb > SILENCE_DB) {
        const gainDb = 20 * Math.log10(sliderToGain(volumeRef.current));
        calibRef.current.push(preDb - gainDb);
      }

      if (++ticks % 30 === 0) setNoiseFloorDb(Math.round(m.floor));
    };

    const id = setInterval(process, 30);
    return () => clearInterval(id);
  }, []);

  // Loop do medidor na tela (~30 quadros/s para não pesar).
  useEffect(() => {
    const timeBuf = new Float32Array(2048);
    let freqBuf = null;

    const tick = (now) => {
      rafRef.current = requestAnimationFrame(tick);
      const analyser = analyserRef.current;
      const m = meterRef.current;
      if (!analyser || !streamRef.current) return;
      m.frame++;
      if (m.frame % 2) return;

      // Medidor depois do portão: você vê o barulho sumir.
      analyser.getFloatTimeDomainData(timeBuf);
      const db = rmsDb(timeBuf);
      const target = mutedRef.current ? 0 : dbToNorm(db);

      // Sobe rápido, desce devagar: o medidor fica "vivo" sem tremer.
      m.level += (target - m.level) * (target > m.level ? 0.6 : 0.18);

      // Envelope lento usado na frase de feedback ("Estou te ouvindo bem!").
      if (target > 0.15) m.lastLoud = now;
      if (target > m.voice) m.voice += (target - m.voice) * 0.35;
      else if (now - m.lastLoud > 1200) m.voice *= 0.95;

      if (!freqBuf || freqBuf.length !== analyser.frequencyBinCount) {
        freqBuf = new Uint8Array(analyser.frequencyBinCount);
      }
      analyser.getByteFrequencyData(freqBuf);
      const nyquist = (ctxRef.current?.sampleRate ?? 48000) / 2;
      const nextBands = new Array(BAND_COUNT);
      for (let b = 0; b < BAND_COUNT; b++) {
        const f0 = 90 * Math.pow(7000 / 90, b / BAND_COUNT);
        const f1 = 90 * Math.pow(7000 / 90, (b + 1) / BAND_COUNT);
        const i0 = Math.floor((f0 / nyquist) * freqBuf.length);
        const i1 = Math.max(i0 + 1, Math.ceil((f1 / nyquist) * freqBuf.length));
        let peak = 0;
        for (let i = i0; i < i1; i++) peak = Math.max(peak, freqBuf[i]);
        nextBands[b] = mutedRef.current ? 0 : clamp(((peak / 255) * 1.15 - 0.2) / 0.8, 0, 1) * Math.min(1, m.level * 1.6);
      }

      setLevel(m.level);
      setVoiceLevel(m.voice);
      setBands(nextBands);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
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

  // Mudo: desliga a trilha de áudio (ninguém recebe som).
  useEffect(() => {
    streamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
  }, [muted]);

  useEffect(() => {
    const gain = gainRef.current;
    if (gain && ctxRef.current) {
      gain.gain.setTargetAtTime(sliderToGain(volume), ctxRef.current.currentTime, 0.05);
    }
    writeStored('volume', volume);
  }, [volume]);

  useEffect(() => {
    const gate = gateRef.current;
    const ctx = ctxRef.current;
    if (!gate || !ctx) return;
    try {
      if (monitor) gate.connect(ctx.destination);
      else gate.disconnect(ctx.destination);
    } catch {
      /* já estava (des)conectado */
    }
  }, [monitor]);

  // Redutor de ruído: ajusta o filtro na hora; a supressão do navegador tenta ao vivo
  // e, se o navegador não deixar, reabre o microfone com a nova configuração.
  useEffect(() => {
    writeStored('noiseLevel', noiseLevel);
    const preset = NOISE_PRESETS[noiseLevel];
    if (highpassRef.current && ctxRef.current) {
      highpassRef.current.frequency.setTargetAtTime(preset.highpass, ctxRef.current.currentTime, 0.05);
    }
    const track = streamRef.current?.getAudioTracks()[0];
    if (!track) return;
    if (track.getSettings?.().noiseSuppression === preset.browserNs) return;
    track.applyConstraints({ noiseSuppression: preset.browserNs }).catch(() => start());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noiseLevel]);

  useEffect(() => {
    writeStored('deviceId', deviceId);
  }, [deviceId]);

  // Plugou ou tirou um microfone: atualiza a lista e reconecta sozinho se preciso.
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

  const toggleMute = useCallback(() => setMuted((m) => !m), []);

  /** Escuta 5 s de fala e acerta o volume para a voz ficar na faixa ideal. */
  const autoAdjust = useCallback(() => {
    if (calibRef.current || statusRef.current !== 'ready') return Promise.resolve({ ok: false, reason: 'busy' });
    setMuted(false);
    setCalibrating(true);
    calibRef.current = [];
    return new Promise((resolve) => {
      setTimeout(() => {
        const samples = calibRef.current ?? [];
        calibRef.current = null;
        setCalibrating(false);
        if (samples.length < 20) {
          resolve({ ok: false, reason: 'silent' });
          return;
        }
        samples.sort((a, b) => a - b);
        const p90 = samples[Math.floor(samples.length * 0.9)];
        const gain = clamp(Math.pow(10, (TARGET_DB - p90) / 20), 0.25, 3.98);
        setVolume(Math.round(gainToSlider(gain)));
        resolve({ ok: true });
      }, CALIBRATION_MS);
    });
  }, []);

  return {
    status,
    devices,
    deviceId,
    deviceLabel,
    sampleRate,
    muted,
    volume,
    monitor,
    noiseLevel,
    noiseFloorDb,
    gateClosed,
    level,
    voiceLevel,
    bands,
    calibrating,
    calibrationMs: CALIBRATION_MS,
    retry: () => start(deviceId),
    chooseDevice,
    toggleMute,
    setVolume,
    setMonitor,
    setNoiseLevel,
    autoAdjust,
  };
}
