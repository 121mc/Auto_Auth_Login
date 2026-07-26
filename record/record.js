const $ = id => document.getElementById(id);
const el = {
  folderCard: $('folderCard'), folderStatus: $('folderStatus'), folderBtn: $('folderBtn'), captcha: $('captcha'),
  target: $('target'), piece: $('piece'), slider: $('slider'), fill: $('sliderFill'), copy: $('sliderCopy'),
  handle: $('handle'), hint: $('hint'), canvas: $('traceCanvas'), reset: $('resetBtn'),
  sampleCount: $('sampleCount'), duration: $('duration'), sampleRate: $('sampleRate'),
  pathLength: $('pathLength'), peakSpeed: $('peakSpeed'), savedCount: $('savedCount'), lastFile: $('lastFile')
};
let directoryHandle = null;
let samples = [];
let targetX = 0, currentX = 0, handleStartX = 0, startClientX = 0, startEventTime = 0;
let dragging = false, saving = false, activePointerId = null, savedCount = 0;
const hasRawPointer = 'onpointerrawupdate' in window;

bindEvents();
resetChallenge();

function bindEvents() {
  el.folderBtn.addEventListener('click', chooseDirectory);
  el.handle.addEventListener('pointerdown', pointerDown);
  window.addEventListener(hasRawPointer ? 'pointerrawupdate' : 'pointermove', pointerMove, { passive: false });
  window.addEventListener('pointerup', pointerUp);
  window.addEventListener('pointercancel', pointerCancel);
  el.reset.addEventListener('click', resetChallenge);
  window.addEventListener('resize', () => { targetX = Math.min(targetX, maxX()); positionTarget(); drawTrace(samples); });
}

async function chooseDirectory() {
  if (typeof window.showDirectoryPicker !== 'function') {
    setFolderError('当前浏览器不支持目录写入');
    return;
  }
  try {
    const selected = await window.showDirectoryPicker({ id: 'nju-slider-recordings', mode: 'readwrite' });
    const permission = await selected.requestPermission({ mode: 'readwrite' });
    if (permission !== 'granted') throw new Error('未获得目录写入权限');
    directoryHandle = selected;
    el.folderCard.classList.add('is-ready');
    el.folderStatus.textContent = '已授权：' + selected.name;
    el.folderBtn.textContent = '更换保存目录';
    el.handle.disabled = false;
    el.copy.textContent = '拖动滑块完成拼图';
    el.hint.textContent = samplingHint();
  } catch (error) {
    if (error.name !== 'AbortError') setFolderError(error.message || '目录授权失败');
  }
}

function setFolderError(message) {
  directoryHandle = null;
  el.folderCard.classList.remove('is-ready');
  el.folderStatus.textContent = message;
  el.handle.disabled = true;
  el.copy.textContent = '请重新选择保存目录';
}

function resetChallenge() {
  dragging = false;
  activePointerId = null;
  samples = [];
  currentX = 0;
  targetX = Math.round(maxX() * (0.62 + Math.random() * 0.27));
  el.captcha.classList.remove('success');
  el.copy.textContent = directoryHandle ? '拖动滑块完成拼图' : '选择目录后即可录制';
  el.hint.textContent = directoryHandle ? samplingHint() : '请先选择项目中的 recordings 文件夹';
  positionTarget();
  updatePosition(0);
  updateStats([]);
  drawTrace([]);
}

function samplingHint() {
  return hasRawPointer ? '已启用 pointerrawupdate，并读取浏览器合并事件' : '使用 pointermove，并读取浏览器合并事件';
}
function maxX() { return Math.max(0, el.slider.clientWidth - el.handle.offsetWidth); }
function positionTarget() { el.target.style.left = `${targetX + 16}px`; }

function pointerDown(event) {
  if (!directoryHandle || dragging || saving || event.button !== 0) return;
  dragging = true;
  activePointerId = event.pointerId;
  startClientX = event.clientX;
  handleStartX = currentX;
  startEventTime = event.timeStamp;
  samples = [];
  el.captcha.classList.remove('success');
  el.copy.textContent = '正在录制位置坐标…';
  el.handle.setPointerCapture(event.pointerId);
  appendSamples(event);
  event.preventDefault();
}

function pointerMove(event) {
  if (!dragging || event.pointerId !== activePointerId) return;
  appendSamples(event);
  updatePosition(handleStartX + event.clientX - startClientX);
  drawTrace(samples);
  updateStats(samples);
  event.preventDefault();
}

function pointerUp(event) {
  if (!dragging || event.pointerId !== activePointerId) return;
  appendSamples(event);
  void finishDrag(Math.abs(currentX - targetX) <= 9);
}

function pointerCancel(event) {
  if (!dragging || event.pointerId !== activePointerId) return;
  dragging = false;
  activePointerId = null;
  el.copy.textContent = '录制已取消';
}

function appendSamples(event) {
  const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
  const batch = coalesced.length ? coalesced : [event];
  const sliderTop = el.slider.getBoundingClientRect().top;
  for (const point of batch) {
    const sample = {
      t: round(Math.max(0, point.timeStamp - startEventTime), 3),
      x: round(point.clientX - startClientX, 3),
      y: round(point.clientY - sliderTop, 3)
    };
    const previous = samples.at(-1);
    if (!previous || sample.t > previous.t || sample.x !== previous.x || sample.y !== previous.y) samples.push(sample);
  }
}

async function finishDrag(success) {
  dragging = false;
  saving = true;
  if (activePointerId !== null && el.handle.hasPointerCapture(activePointerId)) el.handle.releasePointerCapture(activePointerId);
  activePointerId = null;
  el.handle.disabled = true;
  el.captcha.classList.toggle('success', success);
  el.copy.textContent = '正在自动保存坐标…';
  updateStats(samples);
  drawTrace(samples);

  try {
    const filename = await saveCoordinates(samples);
    savedCount += 1;
    el.savedCount.textContent = `${savedCount} 个文件`;
    el.lastFile.textContent = filename;
    el.copy.textContent = success ? '已保存，正在生成新验证码…' : '轨迹已保存，正在生成新验证码…';
    await delay(450);
    resetChallenge();
  } catch (error) {
    setFolderError('写入失败，请重新选择目录');
    el.hint.textContent = error.message || '无法写入 JSON 文件';
  } finally {
    saving = false;
    el.handle.disabled = !directoryHandle;
  }
}

async function saveCoordinates(points) {
  if (!directoryHandle) throw new Error('尚未选择保存目录');
  const permission = await directoryHandle.queryPermission({ mode: 'readwrite' });
  if (permission !== 'granted') throw new Error('目录写入权限已失效');
  const coordinates = points.map(point => ({ x: point.x, y: point.y }));
  const filename = `trajectory-${crypto.randomUUID()}.json`;
  const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(JSON.stringify(coordinates));
  } finally {
    await writable.close();
  }
  return filename;
}

function updatePosition(value) {
  currentX = clamp(value, 0, maxX());
  el.handle.style.transform = `translateX(${currentX}px)`;
  el.fill.style.width = `${currentX + el.handle.offsetWidth / 2}px`;
  el.piece.style.transform = `translateX(${currentX}px)`;
}

function calculateMetrics(points) {
  if (points.length < 2) return { count: points.length, duration: 0, hz: 0, path: 0, peak: 0 };
  let path = 0, peak = 0;
  for (let i = 1; i < points.length; i++) {
    const distance = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    const elapsed = points[i].t - points[i - 1].t;
    path += distance;
    if (elapsed > 0) peak = Math.max(peak, distance / elapsed * 1000);
  }
  const duration = Math.max(0, points.at(-1).t - points[0].t);
  return { count: points.length, duration: round(duration, 1), hz: duration ? round((points.length - 1) / duration * 1000, 1) : 0, path: round(path, 1), peak: round(peak, 1) };
}

function updateStats(points) {
  const metrics = calculateMetrics(points);
  el.sampleCount.textContent = metrics.count;
  el.duration.textContent = `${metrics.duration} ms`;
  el.sampleRate.textContent = `${metrics.hz} Hz`;
  el.pathLength.textContent = `${metrics.path} px`;
  el.peakSpeed.textContent = `${metrics.peak} px/s`;
}

function drawTrace(points) {
  const canvas = el.canvas, ratio = devicePixelRatio || 1, width = canvas.clientWidth, height = canvas.clientHeight;
  canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio); ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(148,163,184,.14)'; ctx.lineWidth = 1;
  for (let x = 20; x < width; x += 20) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
  for (let y = 20; y < height; y += 20) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
  if (points.length < 2) return;
  let minX = Infinity, maxPX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const point of points) { minX = Math.min(minX, point.x); maxPX = Math.max(maxPX, point.x); minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y); }
  const scale = Math.min((width - 28) / Math.max(1, maxPX - minX), (height - 28) / Math.max(1, maxY - minY));
  ctx.beginPath();
  points.forEach((point, index) => { const x = 14 + (point.x - minX) * scale, y = 14 + (point.y - minY) * scale; index ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  const gradient = ctx.createLinearGradient(0, 0, width, 0); gradient.addColorStop(0, '#32d6c8'); gradient.addColorStop(1, '#3b82f6');
  ctx.strokeStyle = gradient; ctx.lineWidth = 2.25; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function round(value, digits) { const factor = 10 ** digits; return Math.round(value * factor) / factor; }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }