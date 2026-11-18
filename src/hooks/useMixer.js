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
 * Dois modos de ligação:
 *   - "single": um receptor com os dois microfones (TX1 = lado esquerdo, TX2 = lado direito).
 *   - "dual":   um receptor para cada microfone (cada canal usa os dois lados do seu receptor somados).
 * Cada receptor é aberto à parte. Se um cair, o outro continua; quando ele volta, a mesa reconecta.
 * "Estéreo falso": muitas entradas (ex.: a entrada de microfone P2 do PC) dizem ter 2 canais,
 * mas mandam o mesmo som nos dois lados. A mesa compara esquerdo e direito o tempo todo e,
 * se forem iguais, passa a tratar como mono (e avisa), em vez de fingir que separou.
 *
 * Depois do portão, cada canal ainda tem:
 *   - Nivelar voz: compressor que sobe quem fala baixo e segura quem grita.
 *   - Anti-vazamento: quando uma pessoa fala e a outra não, o microfone da outra
 *     abaixa 12 dB (ele só estaria captando a voz "vazada" de quem fala).
 * No master, um limitador impede a mistura de estourar.
 * Mesmo no mudo, o detector continua ouvindo para avisar "você está no mudo".
 *
 * Anti-microfonia (Modo Auditório):
 *   - Caminho direto: o som pula o "Nivelar voz" (compressor) e o "Isolar voz" (IA). Os dois atrasam o som
 *     e o compressor sobe o som da caixa entre uma frase e outra, o que alimenta a microfonia.
 *   - Supressor automático: 8 filtros bem estreitos no master. Quando uma frequência começa a "apitar"
 *     (um pico único, muito acima do resto, parado por ~0,25 s), um filtro corta só ela; se continuar,
 *     corta mais fundo. A voz tem vários harmônicos ao mesmo tempo, então não é confundida com apito.
 *
 * Saída (Modo Auditório): master -> supressor -> limitador -> mudo geral -> saída -> placa de som do PC
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

// Estéreo falso: lados com correlação >= 0.97 e mesmo nível por 1,5 s = mesmo som duplicado.
const DUAL_MONO_CORR = 0.97;
const DUAL_MONO_LEVEL_DB = 1.5;
const DUAL_MONO_ON_MS = 1500;
const DUAL_MONO_OFF_MS = 1000;
const DUAL_MONO_SILENCE_DB = -85; // abaixo disso não dá para saber (silêncio digital)
// Nenhum som chegando (nem o chiado de fundo) por 3 s: cabo solto ou microfone no mudo do Windows.
const NO_SIGNAL_MS = 3000;

// Modo Auditório
const OUTPUT_FADE_IN_S = 1.5; // subida suave da saída ao ligar
const TONE_HZ = 1000;
const TONE_AMP = Math.pow(10, -18 / 20) * Math.SQRT2; // tom de referência: -18 dBFS RMS
const TONE_MAX_MS = 60000; // desliga sozinho depois de 1 minuto
const ISOLATOR_LATENCY_MS = 16; // quadro de 768 amostras a 48 kHz
const COMPRESSOR_LATENCY_MS = 6; // o DynamicsCompressorNode do Chrome olha 6 ms à frente

// Supressor de microfonia
const FB_FILTERS = 8;
const FB_FFT = 8192; // ~5,9 Hz por faixa a 48 kHz
const FB_MIN_HZ = 120;
const FB_MAX_HZ = 10000;
const FB_MIN_DB = -50; // só olha picos com volume de verdade
const FB_PEAK_OVER_NEIGHBORS_DB = 15; // pico estreito: bem acima da vizinhança
const FB_PEAK_OVER_REST_DB = 12; // pico único: nenhum outro (fora da vizinhança) perto dele
const FB_HOLD_MS = 250; // parado na mesma frequência por esse tempo = apito
const FB_FIRST_CUT_DB = -12;
const FB_STEP_DB = -3;
const FB_MAX_CUT_DB = -24;
const FB_Q = 20;

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

/** Para cada canal: de qual receptor (chave) e de qual lado ele puxa o som. */
function routesFor(mode, singleKey, dualKeys) {
  return Array.from({ length: CHANNELS }, (_, i) =>
    mode === 'dual' ? { key: dualKeys[i] ?? '', side: 'mix' } : { key: singleKey, side: i === 0 ? 'left' : 'right' },
  );
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
  // Ligação: 'single' (um receptor, dois lados) ou 'dual' (um receptor por microfone).
  const [mode, setModeState] = useState(() => (readStored('mode', 'single') === 'dual' ? 'dual' : 'single'));
  const [dualDevices, setDualDevices] = useState(() => {
    const v = readStored('dualDevices', null);
    return Array.isArray(v) && v.length === CHANNELS ? v.map((x) => (typeof x === 'string' ? x : '')) : ['', ''];
  });
  // De onde cada canal está puxando o som agora: { key, label, side, online, reason }.
  const [sources, setSources] = useState(() => new Array(CHANNELS).fill(null));
  const [sampleRate, setSampleRate] = useState(null);
  const [channelCount, setChannelCount] = useState(2);
  // Os dois lados chegam iguais (estéreo falso)?
  const [dualMono, setDualMono] = useState(false);
  // Os receptores abertos estão mandando silêncio absoluto?
  const [noSignal, setNoSignal] = useState(false);
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
  // Anti-microfonia do Modo Auditório (ligado por padrão) e os cortes que o supressor fez.
  const [antiFeedback, setAntiFeedback] = useState(() => readStored('antiFeedback', true));
  const [notches, setNotches] = useState([]);
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
  // Receptores abertos: chave (deviceId; '' = padrão do Windows) -> conexão.
  const devicesRef = useRef(new Map());
  // Ligação atual de cada canal: { entry, side }.
  const routeRef = useRef(new Array(CHANNELS).fill(null));
  // Há pelo menos um receptor aberto?
  const liveRef = useRef(false);
  const onLostRef = useRef(null);
  const syncRef = useRef(null);
  const devicesListRef = useRef([]);
  // Receptores que caíram enquanto estavam em uso (para avisar "desconectado", não "não achei").
  const lostKeysRef = useRef(new Set());
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
  const dualRef = useRef({ sLL: 0, sRR: 0, sLR: 0, same: false, since: 0 });
  const dualMonoRef = useRef(false);
  const masterProcRef = useRef({ level: 0 });

  statusRef.current = status;
  channelsRef.current = channels;
  // Canais que de fato chegam separados: estéreo falso conta como 1.
  const effectiveChannels = dualMono ? 1 : channelCount;
  channelCountRef.current = effectiveChannels;
  masterRef.current = master;
  // Modo Auditório com anti-microfonia: caminho direto e supressor ligado.
  const feedbackSafe = auditorium && antiFeedback;
  const feedbackSafeRef = useRef(feedbackSafe);
  feedbackSafeRef.current = feedbackSafe;
  // cuts[i]: corte do filtro i ({ freq, gainDb }) ou null se estiver livre.
  const fbRef = useRef({ cand: null, cooldownUntil: 0, cuts: new Array(FB_FILTERS).fill(null) });
  const modeRef = useRef(mode);
  const singleKeyRef = useRef(deviceId);
  const dualDevicesRef = useRef(dualDevices);
  modeRef.current = mode;
  singleKeyRef.current = deviceId;
  dualDevicesRef.current = dualDevices;

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const list = await navigator.mediaDevices.enumerateDevices();
    const inputs = list
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Receptor ${i + 1}` }));
    setDevices(inputs);
    devicesListRef.current = inputs;
    setOutputDevices(
      list
        .filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Saída ${i + 1}` })),
    );
    return inputs;
  }, []);

  const closeEntry = useCallback((e) => {
    try {
      e.source.disconnect();
      e.splitter.disconnect();
      e.mono.disconnect();
    } catch {
      /* já desligado */
    }
    e.stream.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
  }, []);

  const closeAll = useCallback(() => {
    for (const e of devicesRef.current.values()) closeEntry(e);
    devicesRef.current.clear();
    routeRef.current = new Array(CHANNELS).fill(null);
    liveRef.current = false;
  }, [closeEntry]);

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

    const ch = channelsRef.current.map((c) => {
      // Entrada do canal: recebe o lado (ou a mistura) do receptor escolhido.
      const input = ctx.createGain();
      input.channelCount = 1;
      input.channelCountMode = 'explicit';
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

      input.connect(hp);
      hp.connect(dry);
      dry.connect(fader);
      wet.connect(fader);
      fader.connect(detector);
      fader.connect(gate);
      // Nivelar voz: pelo compressor (comp -> makeup) ou direto (lvDry), sem os 6 ms do compressor.
      const lvDry = ctx.createGain();
      lvDry.gain.value = 0;
      gate.connect(comp);
      comp.connect(makeup);
      makeup.connect(duck);
      gate.connect(lvDry);
      lvDry.connect(duck);
      duck.connect(mute);
      mute.connect(analyser);
      mute.connect(sum);
      return { input, hp, dry, wet, iso: null, fader, detector, gate, comp, makeup, lvDry, duck, mute, analyser };
    });

    sum.connect(masterGain);
    // Supressor de microfonia: filtros estreitos (começam neutros, ganho 0 dB) e um analisador fino.
    const fbFilters = Array.from({ length: FB_FILTERS }, () => {
      const f = ctx.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = 1000;
      f.Q.value = FB_Q;
      f.gain.value = 0;
      return f;
    });
    const fbAnalyser = ctx.createAnalyser();
    fbAnalyser.fftSize = FB_FFT;
    fbAnalyser.smoothingTimeConstant = 0;
    let prevNode = masterGain;
    for (const f of fbFilters) {
      prevNode.connect(f);
      prevNode = f;
    }
    prevNode.connect(limiter);
    prevNode.connect(fbAnalyser);
    limiter.connect(masterMute);
    masterMute.connect(masterAnalyser);
    masterMute.connect(out);
    out.connect(ctx.destination);

    ctxRef.current = ctx;
    nodesRef.current = { ch, sum, masterGain, fbFilters, fbAnalyser, limiter, masterMute, masterAnalyser, out };
    fbRef.current = { cand: null, cooldownUntil: 0, cuts: new Array(FB_FILTERS).fill(null) };
    // Gancho só para os testes automáticos (página de teste define window.__duomixTest).
    if (typeof window !== 'undefined' && window.__duomixTest) window.__duomixTest.nodes = nodesRef.current;
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

  /** Abre um receptor e prepara os pontos de onde os canais puxam o som (esquerdo, direito, mistura). */
  const openDevice = useCallback(async (key) => {
    // Processamentos do navegador desligados: eles juntam o som em mono
    // e impediriam de separar os dois microfones.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(key ? { deviceId: { exact: key } } : {}),
        channelCount: { ideal: 2 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const ctx = ctxRef.current;
    const track = stream.getAudioTracks()[0];
    const source = ctx.createMediaStreamSource(stream);
    const splitter = ctx.createChannelSplitter(2);
    // "Mistura": os dois lados somados, para quem usa um receptor por microfone.
    const mono = ctx.createGain();
    mono.channelCount = 1;
    mono.channelCountMode = 'explicit';
    mono.channelInterpretation = 'speakers';
    // Medidores crus de cada lado, para detectar estéreo falso.
    const rawL = ctx.createAnalyser();
    const rawR = ctx.createAnalyser();
    rawL.fftSize = rawR.fftSize = 1024;
    source.connect(splitter);
    source.connect(mono);
    splitter.connect(rawL, 0);
    splitter.connect(rawR, 1);
    const settings = track.getSettings?.() ?? {};
    const entry = {
      key,
      stream,
      source,
      splitter,
      mono,
      rawL,
      rawR,
      label: track.label || 'Receptor',
      channelCount: settings.channelCount === 1 ? 1 : 2,
      latency: Number.isFinite(settings.latency) ? settings.latency : 0,
      ended: false,
    };
    track.onended = () => {
      entry.ended = true;
      onLostRef.current?.(entry);
    };
    return entry;
  }, []);

  /** Liga a entrada de cada canal ao receptor/lado escolhido e conta quem está no ar. */
  const applyRouting = useCallback((routes, errors) => {
    const nodes = nodesRef.current;
    if (!nodes) return [];
    const next = routes.map((r, i) => {
      const input = nodes.ch[i].input;
      const entry = devicesRef.current.get(r.key);
      const usable = entry && !entry.ended ? entry : null;
      const prev = routeRef.current[i];
      if (prev && (prev.entry !== usable || prev.side !== r.side)) {
        try {
          if (prev.side === 'mix') prev.entry.mono.disconnect(input);
          else prev.entry.splitter.disconnect(input, prev.side === 'left' ? 0 : 1);
        } catch {
          /* já desligado */
        }
        routeRef.current[i] = null;
      }
      if (usable && !routeRef.current[i]) {
        if (r.side === 'mix') usable.mono.connect(input);
        else usable.splitter.connect(input, r.side === 'left' ? 0 : 1);
        routeRef.current[i] = { entry: usable, side: r.side };
      }
      return {
        key: r.key,
        side: r.side,
        label: usable?.label ?? null,
        online: Boolean(usable),
        reason: usable ? null : errors[r.key] ?? (entry?.ended ? 'disconnected' : 'notfound'),
      };
    });
    setSources(next);
    return next;
  }, []);

  /** Depois de abrir/fechar receptores: atualiza ligações, estado, nomes e atraso. */
  const finish = useCallback(
    (routes, errors) => {
      const srcs = applyRouting(routes, errors);
      const online = srcs.filter((x) => x.online).length;
      liveRef.current = online > 0;
      setStatus(online > 0 ? 'ready' : Object.values(errors)[0] ?? 'disconnected');
      const entries = [...new Set(routes.map((r) => devicesRef.current.get(r.key)).filter((e) => e && !e.ended))];
      if (modeRef.current === 'single') {
        setChannelCount(entries[0] ? entries[0].channelCount : 2);
        setDeviceLabel(entries[0]?.label ?? '');
      } else {
        setChannelCount(2);
        setDeviceLabel(entries.map((e) => e.label).join(' + '));
      }
      inputLatencyRef.current = Math.max(0, ...entries.map((e) => e.latency));
    },
    [applyRouting],
  );

  /** Abre os receptores que a ligação atual pede e fecha os que sobraram. */
  const sync = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined') {
      setStatus('unsupported');
      return;
    }
    const gen = ++genRef.current;
    const ctx = ensureGraph();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});

    const routes = routesFor(mode, deviceId, dualDevices);
    const wanted = [...new Set(routes.map((r) => r.key))];
    for (const [k, e] of devicesRef.current) {
      if (!wanted.includes(k) || e.ended) {
        closeEntry(e);
        devicesRef.current.delete(k);
      }
    }
    if (statusRef.current !== 'ready') setStatus('requesting');

    const errors = {};
    let reopenedSingle = false;
    // Um receptor de cada vez: alguns drivers não gostam de abrir dois aparelhos juntos.
    for (const k of wanted) {
      if (devicesRef.current.has(k)) continue;
      try {
        let e;
        try {
          e = await openDevice(k);
        } catch (err) {
          // O receptor salvo sumiu? No modo de um receptor, tenta o padrão do Windows.
          if (mode === 'single' && k && (err?.name === 'OverconstrainedError' || err?.name === 'NotFoundError')) {
            e = await openDevice('');
          } else {
            throw err;
          }
        }
        if (gen !== genRef.current || ctxRef.current !== ctx) {
          closeEntry(e);
          return;
        }
        devicesRef.current.set(k, e);
        lostKeysRef.current.delete(k);
        if (mode === 'single') reopenedSingle = true;
      } catch (err) {
        if (gen !== genRef.current) return;
        const reason = errorToStatus(err);
        errors[k] = reason === 'notfound' && lostKeysRef.current.has(k) ? 'disconnected' : reason;
      }
    }
    if (gen !== genRef.current) return;

    if (reopenedSingle) {
      setDualMono(false);
      dualMonoRef.current = false;
      dualRef.current = { sLL: 0, sRR: 0, sLR: 0, same: false, since: 0 };
    }
    finish(routes, errors);
    refreshDevices();
  }, [mode, deviceId, dualDevices, ensureGraph, openDevice, closeEntry, finish, refreshDevices]);
  syncRef.current = sync;

  // Um receptor caiu: tira ele da mesa sem parar o outro.
  onLostRef.current = (entry) => {
    lostKeysRef.current.add(entry.key);
    if (devicesRef.current.get(entry.key) === entry) {
      devicesRef.current.delete(entry.key);
      closeEntry(entry);
    }
    finish(routesFor(modeRef.current, singleKeyRef.current, dualDevicesRef.current), { [entry.key]: 'disconnected' });
  };

  // Abre (ou troca) os receptores sempre que a ligação muda.
  useEffect(() => {
    sync();
  }, [sync]);

  // Ao fechar o app, desliga tudo.
  useEffect(() => {
    return () => {
      genRef.current++;
      closeAll();
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
    const rawBufL = new Float32Array(1024);
    const rawBufR = new Float32Array(1024);
    const spec = new Float32Array(FB_FFT / 2);
    let loudSince = 0;
    let silentSince = 0;
    let noSignalNow = false;
    const sigBuf = new Float32Array(1024);

    /** Procura um apito: pico estreito, único e parado na mesma frequência. Se achar, corta. */
    const detectFeedback = (now) => {
      const nodes = nodesRef.current;
      const ctx = ctxRef.current;
      if (!nodes?.fbAnalyser || !ctx || now < fbRef.current.cooldownUntil) return;
      nodes.fbAnalyser.getFloatFrequencyData(spec);
      const binHz = ctx.sampleRate / FB_FFT;
      const lo = Math.ceil(FB_MIN_HZ / binHz);
      const hi = Math.min(spec.length - 42, Math.floor(FB_MAX_HZ / binHz));
      let k = lo;
      for (let i = lo; i <= hi; i++) if (spec[i] > spec[k]) k = i;
      const v = spec[k];
      const fb = fbRef.current;
      if (!(v > FB_MIN_DB)) {
        fb.cand = null;
        return;
      }
      // Vizinhança (sem o próprio pico): um apito fica bem acima dela.
      let sum = 0;
      let n = 0;
      for (let i = k - 40; i <= k + 40; i++) {
        if (Math.abs(i - k) < 4 || i < 1) continue;
        sum += spec[i];
        n++;
      }
      const overNeighbors = v - sum / n;
      // Fora da vizinhança: na voz sempre há outros harmônicos fortes; no apito, não.
      const guard = Math.max(6, Math.round(k * 0.15));
      let rest = -Infinity;
      for (let i = lo; i <= hi; i++) if (Math.abs(i - k) > guard && spec[i] > rest) rest = spec[i];
      const overRest = v - rest;
      if (overNeighbors < FB_PEAK_OVER_NEIGHBORS_DB || overRest < FB_PEAK_OVER_REST_DB) {
        fb.cand = null;
        return;
      }
      // Frequência exata do pico (interpolação parabólica entre as faixas vizinhas).
      const a = spec[k - 1];
      const c = spec[k + 1];
      const delta = (0.5 * (a - c)) / (a - 2 * v + c || 1);
      const freq = (k + delta) * binHz;
      if (fb.cand && Math.abs(freq - fb.cand.freq) <= binHz * 2) {
        fb.cand.count++;
        fb.cand.freq = freq;
      } else {
        fb.cand = { freq, since: now, count: 1 };
      }
      if (fb.cand.count >= 3 && now - fb.cand.since >= FB_HOLD_MS) {
        cutFeedback(fb.cand.freq);
        fb.cand = null;
        fb.cooldownUntil = now + 300;
      }
    };

    /** Corta a frequência do apito: aprofunda um filtro que já está perto, ou usa um livre. */
    const cutFeedback = (freq) => {
      const nodes = nodesRef.current;
      const ctx = ctxRef.current;
      const filters = nodes.fbFilters;
      const cuts = fbRef.current.cuts;
      let i = cuts.findIndex((c) => c && Math.abs(c.freq - freq) / freq < 0.03);
      if (i >= 0) {
        cuts[i] = { freq, gainDb: Math.max(FB_MAX_CUT_DB, cuts[i].gainDb + FB_STEP_DB) };
      } else {
        // Um filtro livre; se todos estiverem em uso, troca o de corte mais raso.
        i = cuts.findIndex((c) => c === null);
        if (i < 0) i = cuts.reduce((best, c, j) => (c.gainDb > cuts[best].gainDb ? j : best), 0);
        cuts[i] = { freq, gainDb: FB_FIRST_CUT_DB };
        filters[i].frequency.setValueAtTime(freq, ctx.currentTime);
      }
      filters[i].frequency.setTargetAtTime(freq, ctx.currentTime, 0.01);
      filters[i].gain.setTargetAtTime(cuts[i].gainDb, ctx.currentTime, 0.005);
      setNotches(
        cuts
          .filter(Boolean)
          .map((c) => ({ freq: Math.round(c.freq), gainDb: c.gainDb }))
          .sort((a, b) => a.freq - b.freq),
      );
    };

    const process = () => {
      const nodes = nodesRef.current;
      if (!nodes || !liveRef.current) return;
      const now = performance.now();

      // Estéreo falso: compara os dois lados crus (média móvel de ~0,5 s). Só faz sentido
      // com um receptor para os dois microfones.
      const single = modeRef.current === 'single' ? devicesRef.current.get(singleKeyRef.current) : null;
      if (!single && dualMonoRef.current) {
        dualMonoRef.current = false;
        setDualMono(false);
      }
      if (single && !single.ended) {
        single.rawL.getFloatTimeDomainData(rawBufL);
        single.rawR.getFloatTimeDomainData(rawBufR);
        let ll = 0;
        let rr = 0;
        let lr = 0;
        for (let k = 0; k < rawBufL.length; k++) {
          ll += rawBufL[k] * rawBufL[k];
          rr += rawBufR[k] * rawBufR[k];
          lr += rawBufL[k] * rawBufR[k];
        }
        const d = dualRef.current;
        d.sLL = d.sLL * 0.9 + ll;
        d.sRR = d.sRR * 0.9 + rr;
        d.sLR = d.sLR * 0.9 + lr;
        const dbL = 10 * Math.log10(ll / rawBufL.length + 1e-20);
        const dbR = 10 * Math.log10(rr / rawBufR.length + 1e-20);
        if (dbL > DUAL_MONO_SILENCE_DB && dbR > DUAL_MONO_SILENCE_DB && d.sLL > 0 && d.sRR > 0) {
          const corr = d.sLR / Math.sqrt(d.sLL * d.sRR);
          const same = corr >= DUAL_MONO_CORR && Math.abs(dbL - dbR) <= DUAL_MONO_LEVEL_DB;
          if (same !== d.same) {
            d.same = same;
            d.since = now;
          }
          // Só muda de estado depois de um tempo firme no novo estado (evita piscar).
          let wantDual = dualMonoRef.current;
          if (same && now - d.since >= DUAL_MONO_ON_MS) wantDual = true;
          if (!same && now - d.since >= DUAL_MONO_OFF_MS) wantDual = false;
          if (wantDual !== dualMonoRef.current) {
            dualMonoRef.current = wantDual;
            setDualMono(wantDual);
          }
        }
      }

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

      if (feedbackSafeRef.current && outputOnRef.current) detectFeedback(now);

      // Silêncio absoluto em todos os receptores abertos (nem chiado): avisa para conferir cabo e mudo do Windows.
      let anySignal = false;
      for (const e of devicesRef.current.values()) {
        if (e.ended) continue;
        for (const a of [e.rawL, e.rawR]) {
          a.getFloatTimeDomainData(sigBuf);
          if (rmsDb(sigBuf) > DUAL_MONO_SILENCE_DB) anySignal = true;
        }
      }
      if (anySignal) {
        silentSince = 0;
        loudSince = loudSince || now;
      } else {
        loudSince = 0;
        silentSince = silentSince || now;
      }
      const wantNoSignal = noSignalNow ? !anySignal ? true : now - loudSince < 300 : silentSince && now - silentSince >= NO_SIGNAL_MS;
      if (Boolean(wantNoSignal) !== noSignalNow) {
        noSignalNow = Boolean(wantNoSignal);
        setNoSignal(noSignalNow);
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
      if (!nodes || !liveRef.current) return;
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
        // Nivelar voz: compressor ligado, ou caminho direto (sem o atraso do compressor).
        // No Modo Auditório com anti-microfonia, fica pausado.
        const lv = c.leveler && !feedbackSafe;
        n.lvDry.gain.setTargetAtTime(lv ? 0 : 1, ctx.currentTime, 0.03);
        n.comp.threshold.setTargetAtTime(lv ? LEVELER.threshold : 0, ctx.currentTime, 0.05);
        n.comp.knee.setTargetAtTime(lv ? LEVELER.knee : 0, ctx.currentTime, 0.05);
        n.comp.ratio.setTargetAtTime(lv ? LEVELER.ratio : 1, ctx.currentTime, 0.05);
        n.comp.attack.value = LEVELER.attack;
        n.comp.release.value = LEVELER.release;
        n.makeup.gain.setTargetAtTime(lv ? Math.pow(10, LEVELER.makeupDb / 20) : 0, ctx.currentTime, 0.03);
        // Isolador: troca suave entre o caminho direto e o caminho pela IA.
        const useIso = c.isolate && !!n.iso && !feedbackSafe;
        n.wet.gain.setTargetAtTime(useIso ? 1 : 0, ctx.currentTime, 0.03);
        n.dry.gain.setTargetAtTime(useIso ? 0 : 1, ctx.currentTime, 0.03);
      });
      if (channels.some((c) => c.isolate) && isolator.status === 'idle' && !feedbackSafe) ensureIsolator();
    }
    writeStored(
      'channels',
      channels.map(({ name, volume, noise, isolate, leveler }) => ({ name, volume, noise, isolate, leveler })),
    );
  }, [channels, isolator.status, status, ensureIsolator, feedbackSafe]);

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

  useEffect(() => {
    writeStored('antiFeedback', antiFeedback);
  }, [antiFeedback]);

  /** Tira todos os cortes do supressor (por exemplo, ao mudar de sala). */
  const clearNotches = useCallback(() => {
    const nodes = nodesRef.current;
    const ctx = ctxRef.current;
    nodes?.fbFilters.forEach((f) => {
      f.gain.cancelScheduledValues(ctx.currentTime);
      f.gain.setValueAtTime(0, ctx.currentTime);
    });
    fbRef.current = { cand: null, cooldownUntil: 0, cuts: new Array(FB_FILTERS).fill(null) };
    setNotches([]);
  }, []);

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
  const anyIsolate = channels.some((c) => c.isolate) && isolator.status === 'ready' && !feedbackSafe;
  const anyLeveler = channels.some((c) => c.leveler) && !feedbackSafe;
  useEffect(() => {
    const read = () => {
      const ctx = ctxRef.current;
      if (!ctx || statusRef.current !== 'ready') return setLatencyMs(null);
      const sec = (ctx.baseLatency || 0) + (ctx.outputLatency || 0) + inputLatencyRef.current;
      const extra =
        (anyIsolate ? ISOLATOR_LATENCY_MS : 0) + (anyLeveler ? COMPRESSOR_LATENCY_MS : 0) + COMPRESSOR_LATENCY_MS; // + limitador
      setLatencyMs(Math.round(sec * 1000 + extra));
    };
    read();
    const id = setInterval(read, 2000);
    return () => clearInterval(id);
  }, [status, anyIsolate, anyLeveler]);

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

  useEffect(() => {
    writeStored('mode', mode);
    writeStored('dualDevices', dualDevices);
  }, [mode, dualDevices]);

  // Plugou ou tirou o receptor: atualiza a lista e reconecta sozinho se preciso.
  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md?.addEventListener) return;
    const onChange = async () => {
      await refreshDevices();
      const routes = routesFor(modeRef.current, singleKeyRef.current, dualDevicesRef.current);
      const missing = routes.some((r) => {
        const e = devicesRef.current.get(r.key);
        return !e || e.ended;
      });
      if (missing) syncRef.current?.();
    };
    md.addEventListener('devicechange', onChange);
    return () => md.removeEventListener('devicechange', onChange);
  }, [refreshDevices]);

  // Trocar de receptor só muda o estado: o efeito de sincronização reabre o que for preciso.
  const chooseDevice = useCallback((id) => setDeviceId(id), []);

  const setMode = useCallback((m) => {
    setModeState(m);
    // Primeira vez no modo de dois receptores: já sugere os dois primeiros aparelhos.
    if (m === 'dual') {
      setDualDevices((d) => {
        if (d[0] || d[1]) return d;
        const real = devicesListRef.current.filter((x) => x.id !== 'default' && x.id !== 'communications');
        return [real[0]?.id ?? '', real[1]?.id ?? ''];
      });
    }
  }, []);

  const setDualDevice = useCallback((i, id) => {
    setDualDevices((d) => d.map((v, j) => (j === i ? id : v)));
  }, []);

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
    channelCount: effectiveChannels,
    reportedChannels: channelCount,
    dualMono,
    noSignal,
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
    retry: () => sync(),
    mode,
    setMode,
    dualDevices,
    setDualDevice,
    sources,
    auditorium,
    setAuditorium,
    outputOn,
    outputDevices,
    outputDeviceId,
    setOutputDeviceId,
    sinkSupported,
    toneOn,
    setToneOn,
    antiFeedback,
    setAntiFeedback,
    feedbackSafe,
    notches,
    clearNotches,
    latencyMs,
    wakeLock,
    chooseDevice,
    setChannel,
    setMaster,
    autoAdjust,
  };
}
