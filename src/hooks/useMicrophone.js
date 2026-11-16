import { useCallback, useEffect, useRef, useState } from 'react';

/*
 * useMicrophone: toda a parte de áudio do app, via Web Audio API.
 *
 * Cadeia de áudio: microfone -> GainNode (volume da voz) -> AnalyserNode (medidor)
 *                                         \-> alto-falante/fone (só com "Me ouvir no fone")
 *
 * Limitação do navegador: o "volume da sua voz" altera o sinal dentro do app,
 * não o ganho do microfone no Windows. Para mexer no hardware de verdade
 * (ganho físico, LED, botão de mudo), o app precisa rodar empacotado em
 * Electron ou Tauri, com acesso nativo.
 */

const MIN_DB = -60;
const MAX_DB = -6;
const SILENCE_DB = -52;
const TARGET_DB = -20;
const CALIBRATION_MS = 5000;
export const BAND_COUNT = 8;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dbToNorm = (db) => clamp((db - MIN_DB) / (MAX_DB - MIN_DB), 0, 1);

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
  const [noiseSuppression, setNoiseSuppression] = useState(() => readStored('noiseSuppression', true));
  const [level, setLevel] = useState(0);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [bands, setBands] = useState(() => new Array(BAND_COUNT).fill(0));
  const [calibrating, setCalibrating] = useState(false);

  const ctxRef = useRef(null);
  const gainRef = useRef(null);
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
  const nsRef = useRef(noiseSuppression);
  const meterRef = useRef({ level: 0, voice: 0, lastLoud: 0, frame: 0 });

  statusRef.current = status;
  mutedRef.current = muted;
  volumeRef.current = volume;
  monitorRef.current = monitor;
  nsRef.current = noiseSuppression;

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
    const gain = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.6;
    gain.gain.value = sliderToGain(volumeRef.current);
    gain.connect(analyser);
    if (monitorRef.current) gain.connect(ctx.destination);
    ctxRef.current = ctx;
    gainRef.current = gain;
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
          noiseSuppression: nsRef.current,
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
      source.connect(gainRef.current);
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
      gainRef.current = null;
      analyserRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Loop do medidor (~30 quadros/s para não pesar na tela).
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

      analyser.getFloatTimeDomainData(timeBuf);
      let sum = 0;
      for (let i = 0; i < timeBuf.length; i++) sum += timeBuf[i] * timeBuf[i];
      const rms = Math.sqrt(sum / timeBuf.length);
      const db = rms > 0 ? 20 * Math.log10(rms) : -120;
      const target = mutedRef.current ? 0 : dbToNorm(db);

      // Sobe rápido, desce devagar: o medidor fica "vivo" sem tremer.
      m.level += (target - m.level) * (target > m.level ? 0.6 : 0.18);

      // Envelope lento usado na frase de feedback ("Estou te ouvindo bem!").
      if (target > 0.15) m.lastLoud = now;
      if (target > m.voice) m.voice += (target - m.voice) * 0.35;
      else if (now - m.lastLoud > 1200) m.voice *= 0.95;

      if (calibRef.current && !mutedRef.current && db > SILENCE_DB) {
        const gainDb = 20 * Math.log10(sliderToGain(volumeRef.current));
        calibRef.current.push(db - gainDb);
      }

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
    const gain = gainRef.current;
    const ctx = ctxRef.current;
    if (!gain || !ctx) return;
    try {
      if (monitor) gain.connect(ctx.destination);
      else gain.disconnect(ctx.destination);
    } catch {
      /* já estava (des)conectado */
    }
  }, [monitor]);

  // Tira barulho: tenta aplicar ao vivo; se o navegador não deixar, reabre o microfone.
  useEffect(() => {
    writeStored('noiseSuppression', noiseSuppression);
    const track = streamRef.current?.getAudioTracks()[0];
    if (!track) return;
    if (track.getSettings?.().noiseSuppression === noiseSuppression) return;
    track.applyConstraints({ noiseSuppression }).catch(() => start());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noiseSuppression]);

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
    noiseSuppression,
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
    setNoiseSuppression,
    autoAdjust,
  };
}
