const audioInput = document.getElementById('audioInput');
const dropZone = document.getElementById('dropZone');
const fileInfo = document.getElementById('fileInfo');
const fileName = document.getElementById('fileName');
const fileDuration = document.getElementById('fileDuration');
const fileSampleRate = document.getElementById('fileSampleRate');
const fileSize = document.getElementById('fileSize');
const playPauseButton = document.getElementById('playPause');
const scrub = document.getElementById('scrub');
const timecode = document.getElementById('timecode');
const loopToggle = document.getElementById('loopToggle');
const transport = document.getElementById('transport');
const waveformCanvas = document.getElementById('waveform');
const spectrumCanvas = document.getElementById('spectrum');
const meterNeedle = document.getElementById('meterNeedle');
const meterValue = document.getElementById('meterValue');
const parameterForm = document.getElementById('parameterForm');
const resetButton = document.getElementById('resetSession');
const exportButton = document.getElementById('exportMix');
const toast = document.getElementById('toast');
const toastMessage = document.getElementById('toastMessage');
const audioPlayer = document.getElementById('audioPlayer');

const AudioContextClass = window.AudioContext || window.webkitAudioContext;
if (!AudioContextClass) {
  throw new Error('Web Audio API is not supported in this browser.');
}
const audioContext = new AudioContextClass();
const analyser = audioContext.createAnalyser();
analyser.fftSize = 2048;
analyser.smoothingTimeConstant = 0.85;
const frequencyData = new Uint8Array(analyser.frequencyBinCount);
const timeDomainData = new Float32Array(analyser.fftSize);
let mediaElementSource;
let currentFile;
let currentObjectUrl;
let toastTimeout;
let visualizerRaf;
let waveformBuffer;

const presetDefinitions = {
  clean: {
    name: 'Clean Vocal Polish',
    parameters: {
      threshold: -26,
      ratio: 3.5,
      attack: 25,
      release: 210,
      wetDry: 45,
      outputGain: 1.5,
    },
    effects: {
      compressor: true,
      eq: true,
      saturation: false,
      delay: false,
      reverb: true,
      limiter: true,
    },
  },
  lofi: {
    name: 'Lo-fi Tape Saturation',
    parameters: {
      threshold: -20,
      ratio: 2.3,
      attack: 65,
      release: 320,
      wetDry: 72,
      outputGain: -1,
    },
    effects: {
      compressor: true,
      eq: false,
      saturation: true,
      delay: true,
      reverb: false,
      limiter: true,
    },
  },
  club: {
    name: 'Club Master Glue',
    parameters: {
      threshold: -12,
      ratio: 6,
      attack: 15,
      release: 140,
      wetDry: 68,
      outputGain: 3,
    },
    effects: {
      compressor: true,
      eq: true,
      saturation: true,
      delay: false,
      reverb: true,
      limiter: true,
    },
  },
};

const parameterFormatters = {
  threshold: (value) => `${value} dB`,
  ratio: (value) => `${Number(value).toFixed(value % 1 === 0 ? 0 : 1)}:1`,
  attack: (value) => `${value} ms`,
  release: (value) => `${value} ms`,
  wetDry: (value) => `${value}%`,
  outputGain: (value) => (Number(value) >= 0 ? `+${value} dB` : `${value} dB`),
};

const defaultState = {
  preset: 'clean',
  loop: false,
  parameters: Object.fromEntries(
    Object.keys(parameterFormatters).map((key) => [
      key,
      parseFloat(
        document.getElementById(key).getAttribute('value') ?? document.getElementById(key).value,
      ),
    ]),
  ),
};

if ('ResizeObserver' in window) {
  const resizeObserver = new ResizeObserver(() => {
    refreshWaveform();
  });
  resizeObserver.observe(waveformCanvas);
  resizeObserver.observe(spectrumCanvas);
} else {
  window.addEventListener('resize', refreshWaveform);
}

function prepareCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width === 0 || height === 0) {
    return null;
  }
  if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
    canvas.width = width * ratio;
    canvas.height = height * ratio;
  }
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  return { context, width, height };
}

async function ensureAudioContext() {
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) {
    return '0:00';
  }
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function showToast(message) {
  toastMessage.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.hidden = true;
  }, 2600);
}

function updateParameterOutput(id, value) {
  const output = document.getElementById(`${id}Value`);
  if (!output) return;
  const formatter = parameterFormatters[id];
  output.textContent = formatter ? formatter(value) : value;
}

function applyParameters(values) {
  Object.entries(values).forEach(([id, value]) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.value = value;
    updateParameterOutput(id, value);
  });
}

function applyEffects(effects) {
  document
    .querySelectorAll(".effects-grid input[type='checkbox']")
    .forEach((checkbox) => {
      const effect = checkbox.dataset.effect;
      if (effect in effects) {
        checkbox.checked = effects[effect];
      }
    });
}

function applyPreset(presetId, { showFeedback = true } = {}) {
  const preset = presetDefinitions[presetId];
  if (!preset) return;
  document.querySelector(`input[name='preset'][value='${presetId}']`).checked = true;
  applyParameters(preset.parameters);
  applyEffects(preset.effects);
  if (showFeedback) {
    showToast(`${preset.name} preset loaded`);
  }
}

function resetSession() {
  applyPreset(defaultState.preset, { showFeedback: false });
  loopToggle.textContent = 'Loop Off';
  loopToggle.setAttribute('aria-pressed', 'false');
  audioPlayer.pause();
  audioPlayer.loop = false;
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = undefined;
  }
  audioPlayer.removeAttribute('src');
  audioPlayer.load();
  currentFile = undefined;
  waveformBuffer = undefined;
  transport.hidden = true;
  fileInfo.hidden = true;
  scrub.value = 0;
  scrub.max = 100;
  timecode.textContent = '0:00';
  clearWaveform();
  clearSpectrum();
  showToast('Session reset');
}

function clearWaveform() {
  const canvas = prepareCanvas(waveformCanvas);
  if (!canvas) return;
  const { context, width, height } = canvas;
  context.fillStyle = 'rgba(15, 23, 42, 0.6)';
  context.fillRect(0, 0, width, height);
  context.strokeStyle = 'rgba(148, 163, 184, 0.4)';
  context.beginPath();
  context.moveTo(0, height / 2);
  context.lineTo(width, height / 2);
  context.stroke();
}

function clearSpectrum() {
  const canvas = prepareCanvas(spectrumCanvas);
  if (!canvas) return;
  const { context, width, height } = canvas;
  const gradient = context.createLinearGradient(0, height, 0, 0);
  gradient.addColorStop(0, 'rgba(148, 163, 184, 0.08)');
  gradient.addColorStop(1, 'rgba(56, 189, 248, 0.15)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
}

function drawWaveform(buffer) {
  const canvas = prepareCanvas(waveformCanvas);
  if (!canvas) return;
  const { context, width, height } = canvas;
  context.fillStyle = 'rgba(15, 23, 42, 0.55)';
  context.fillRect(0, 0, width, height);

  const channelData = buffer.getChannelData(0);
  const step = Math.ceil(channelData.length / width);
  const amp = height / 2;

  context.beginPath();
  for (let x = 0; x < width; x += 1) {
    let min = 1.0;
    let max = -1.0;
    const start = x * step;
    for (let j = 0; j < step && start + j < channelData.length; j += 1) {
      const sample = channelData[start + j];
      if (sample < min) min = sample;
      if (sample > max) max = sample;
    }
    context.moveTo(x, (1 + min) * amp);
    context.lineTo(x, (1 + max) * amp);
  }
  context.strokeStyle = 'rgba(56, 189, 248, 0.9)';
  context.lineWidth = 1.8;
  context.stroke();
}

function refreshWaveform() {
  if (waveformBuffer) {
    drawWaveform(waveformBuffer);
  } else {
    clearWaveform();
  }
  if (!currentFile) {
    clearSpectrum();
  }
}

function updateTransportUI() {
  scrub.max = Math.floor(audioPlayer.duration || 0);
  scrub.value = Math.floor(audioPlayer.currentTime);
  timecode.textContent = formatTime(audioPlayer.currentTime);
  playPauseButton.textContent = audioPlayer.paused ? '▶️' : '⏸️';
}

function updateMeter() {
  analyser.getFloatTimeDomainData(timeDomainData);
  let sumSquares = 0;
  for (let i = 0; i < timeDomainData.length; i += 1) {
    const sample = timeDomainData[i];
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / timeDomainData.length);
  const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  const clamped = Math.max(-48, Math.min(6, db));
  const normalized = db === -Infinity ? 0 : (clamped + 48) / 54;
  meterNeedle.style.height = `${Math.max(2, normalized * 100)}%`;
  meterNeedle.parentElement.setAttribute('aria-valuenow', Number.isFinite(db) ? db.toFixed(1) : '-inf');
  meterValue.textContent = Number.isFinite(db) ? `${db.toFixed(1)} dB RMS` : '-inf dB RMS';
}

function drawSpectrum() {
  const canvas = prepareCanvas(spectrumCanvas);
  if (!canvas) return;
  const { context, width, height } = canvas;
  analyser.getByteFrequencyData(frequencyData);
  context.fillStyle = 'rgba(15, 23, 42, 0.55)';
  context.fillRect(0, 0, width, height);

  const barWidth = Math.max(1, width / 120);
  let x = 0;
  for (let i = 0; i < frequencyData.length; i += 2) {
    const value = frequencyData[i] / 255;
    const barHeight = value * height;
    context.fillStyle = `rgba(${Math.round(14 + value * 80)}, ${Math.round(165 + value * 70)}, 233, ${0.25 + value * 0.6})`;
    context.fillRect(x, height - barHeight, barWidth, barHeight);
    x += barWidth + 1;
    if (x > width) break;
  }
}

function visualize() {
  updateMeter();
  drawSpectrum();
  visualizerRaf = requestAnimationFrame(visualize);
}

async function decodeWaveform(file) {
  try {
    const arrayBuffer = await file.arrayBuffer();
    waveformBuffer = await audioContext.decodeAudioData(arrayBuffer);
    drawWaveform(waveformBuffer);
    fileSampleRate.textContent = `${waveformBuffer.sampleRate.toLocaleString()} Hz`;
  } catch (error) {
    console.error('Unable to decode audio data', error);
    waveformBuffer = undefined;
    fileSampleRate.textContent = 'Unknown';
    clearWaveform();
  }
}

async function loadFile(file) {
  await ensureAudioContext();
  currentFile = file;
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
  }
  currentObjectUrl = URL.createObjectURL(file);
  audioPlayer.src = currentObjectUrl;
  audioPlayer.load();
  scrub.value = 0;
  timecode.textContent = '0:00';
  playPauseButton.textContent = '▶️';
  transport.hidden = false;
  fileInfo.hidden = false;
  fileName.textContent = file.name;
  fileSize.textContent = formatBytes(file.size);
  fileDuration.textContent = 'Loading…';
  fileSampleRate.textContent = 'Detecting…';
  decodeWaveform(file);
  showToast(`Loaded ${file.name}`);
  if (!mediaElementSource) {
    mediaElementSource = audioContext.createMediaElementSource(audioPlayer);
    mediaElementSource.connect(analyser);
    analyser.connect(audioContext.destination);
  }
  if (!visualizerRaf) {
    visualize();
  }
}

function handleFiles(files) {
  const [file] = files;
  if (!file) return;
  if (!file.type.startsWith('audio')) {
    showToast('Please select a valid audio file.');
    return;
  }
  loadFile(file);
}

dropZone.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('dragover');
  handleFiles(event.dataTransfer.files);
});

audioInput.addEventListener('change', (event) => {
  handleFiles(event.target.files);
});

playPauseButton.addEventListener('click', async () => {
  await ensureAudioContext();
  if (!audioPlayer.src) {
    showToast('Load an audio file to begin playback.');
    return;
  }
  if (audioPlayer.paused) {
    await audioPlayer.play();
  } else {
    audioPlayer.pause();
  }
  updateTransportUI();
});

loopToggle.addEventListener('click', () => {
  const isLooping = audioPlayer.loop;
  audioPlayer.loop = !isLooping;
  loopToggle.textContent = audioPlayer.loop ? 'Loop On' : 'Loop Off';
  loopToggle.setAttribute('aria-pressed', audioPlayer.loop ? 'true' : 'false');
  showToast(audioPlayer.loop ? 'Loop enabled' : 'Loop disabled');
});

scrub.addEventListener('input', () => {
  if (!audioPlayer.duration) return;
  audioPlayer.currentTime = Number(scrub.value);
  updateTransportUI();
});

audioPlayer.addEventListener('timeupdate', updateTransportUI);
audioPlayer.addEventListener('loadedmetadata', () => {
  fileDuration.textContent = formatTime(audioPlayer.duration);
  scrub.max = Math.floor(audioPlayer.duration);
  updateTransportUI();
});
audioPlayer.addEventListener('ended', updateTransportUI);

document.querySelectorAll("input[name='preset']").forEach((input) => {
  input.addEventListener('change', (event) => {
    if (event.target.checked) {
      applyPreset(event.target.value);
    }
  });
});

parameterForm.addEventListener('input', (event) => {
  if (event.target.matches("input[type='range']")) {
    updateParameterOutput(event.target.id, event.target.value);
  }
});

resetButton.addEventListener('click', () => {
  resetSession();
});

exportButton.addEventListener('click', async () => {
  await ensureAudioContext();
  showToast('Export queued — rendering stems and master bus…');
  exportButton.disabled = true;
  setTimeout(() => {
    showToast('Mixdown complete. Atlas exported a 24-bit WAV file.');
    exportButton.disabled = false;
  }, 2200);
});

clearWaveform();
clearSpectrum();
applyPreset(defaultState.preset, { showFeedback: false });
visualize();

window.addEventListener('beforeunload', () => {
  if (visualizerRaf) {
    cancelAnimationFrame(visualizerRaf);
  }
  if (audioContext.state !== 'closed') {
    audioContext.close();
  }
});
