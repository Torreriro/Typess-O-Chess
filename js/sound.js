// Tiny synthesized sounds (WebAudio), so there are no audio files to ship.
let ctx = null;
let muted = false;
try { muted = localStorage.getItem('sahuno.muted') === '1'; } catch { /* ignore */ }

export const isMuted = () => muted;
export function setMuted(v) {
  muted = v;
  try { localStorage.setItem('sahuno.muted', v ? '1' : '0'); } catch { /* ignore */ }
}

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function knock(freq, dur, gain) {
  const a = ac();
  const t = a.currentTime;
  const len = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 6);
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = 3;
  const g = a.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(a.destination);
  src.start(t);
}

function tone(freq, dur, gain, type = 'sine', slide = 0) {
  const a = ac();
  const t = a.currentTime;
  const o = a.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur);
}

export function play(kind) {
  if (muted) return;
  try {
    switch (kind) {
      case 'move': knock(900, 0.08, 1.4); break;
      case 'capture': knock(520, 0.12, 2); knock(1300, 0.05, 0.8); break;
      case 'card': knock(3200, 0.16, 0.5); break;
      case 'reverse': tone(330, 0.25, 0.12, 'triangle', 1.6); break;
      case 'skip': tone(240, 0.22, 0.12, 'square', 0.6); break;
      case 'revive': tone(520, 0.18, 0.1, 'sine', 1.5); setTimeout(() => tone(780, 0.2, 0.08), 90); break;
      case 'check': tone(880, 0.12, 0.07, 'triangle'); break;
      case 'end': tone(440, 0.3, 0.1); setTimeout(() => tone(660, 0.45, 0.09), 140); break;
      case 'notify': tone(660, 0.12, 0.06); break;
    }
  } catch { /* audio not available */ }
}
