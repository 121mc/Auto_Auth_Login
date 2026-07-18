const DEBUG_RECORD_PREFIX = 'nju_debug_record_';

const elements = {
  modeBadge: document.getElementById('modeBadge'),
  totalCount: document.getElementById('totalCount'),
  successCount: document.getElementById('successCount'),
  errorCount: document.getElementById('errorCount'),
  averageTime: document.getElementById('averageTime'),
  sessionStarted: document.getElementById('sessionStarted'),
  emptyState: document.getElementById('emptyState'),
  recordList: document.getElementById('recordList'),
  template: document.getElementById('recordTemplate'),
  clearBtn: document.getElementById('clearBtn'),
  exportBtn: document.getElementById('exportBtn')
};

let currentSessionId = null;
let records = [];

document.addEventListener('DOMContentLoaded', initialize);

async function initialize() {
  await loadState();
  elements.clearBtn.addEventListener('click', clearRecords);
  elements.exportBtn.addEventListener('click', exportRecords);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    if (changes.nju_debug_mode || changes.nju_debug_session_id || changes.nju_debug_started_at) {
      loadState();
      return;
    }

    let changed = false;
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(DEBUG_RECORD_PREFIX)) continue;
      changed = true;
      if (change.newValue && change.newValue.sessionId === currentSessionId) {
        const existingIndex = records.findIndex(record => record.id === change.newValue.id);
        if (existingIndex === -1) records.push(change.newValue);
        else records[existingIndex] = change.newValue;
      } else if (change.oldValue) {
        records = records.filter(record => record.id !== change.oldValue.id);
      }
    }
    if (changed) render();
  });
}

async function loadState() {
  const data = await chrome.storage.local.get(null);
  currentSessionId = data.nju_debug_session_id || null;
  records = Object.entries(data)
    .filter(([key, value]) => key.startsWith(DEBUG_RECORD_PREFIX)
      && value && value.sessionId === currentSessionId)
    .map(([, value]) => value);

  const active = data.nju_debug_mode === true;
  elements.modeBadge.classList.toggle('active', active);
  elements.modeBadge.querySelector('span').textContent = active ? 'Debug 记录中' : 'Debug 已关闭';
  elements.sessionStarted.textContent = data.nju_debug_started_at
    ? formatTime(data.nju_debug_started_at)
    : '-';
  render();
}

function render() {
  records.sort((a, b) => b.finishedAt - a.finishedAt);
  elements.recordList.replaceChildren();

  for (const record of records) {
    elements.recordList.appendChild(createRecordCard(record));
  }

  const successCount = records.filter(record => record.status === 'success').length;
  const errorCount = records.length - successCount;
  const totalDuration = records.reduce((sum, record) => sum + (Number(record.durationMs) || 0), 0);
  elements.totalCount.textContent = String(records.length);
  elements.successCount.textContent = String(successCount);
  elements.errorCount.textContent = String(errorCount);
  elements.averageTime.textContent = records.length
    ? `${Math.round(totalDuration / records.length)} ms`
    : '-';
  elements.emptyState.hidden = records.length > 0;
}

function createRecordCard(record) {
  const card = elements.template.content.firstElementChild.cloneNode(true);
  const isClick = record.captchaType === 'click';
  const success = record.status === 'success';
  card.classList.toggle('is-error', !success);
  card.querySelector('.type-badge').textContent = isClick ? '点选验证码' : '字符验证码';
  const statusBadge = card.querySelector('.status-badge');
  statusBadge.textContent = success ? '成功' : '失败';
  statusBadge.classList.add(success ? 'success' : 'error');
  card.querySelector('.source').textContent = record.source || '未知来源';
  card.querySelector('.timestamp').textContent = formatTime(record.finishedAt, true);
  card.querySelector('.duration').textContent = `${record.durationMs} ms`;
  card.querySelector('.attempt').textContent = record.context?.attempt ?? '-';
  card.querySelector('.raw-timestamp').textContent = String(record.finishedAt);
  card.querySelector('.context').textContent = JSON.stringify({
    recordId: record.id,
    sessionId: record.sessionId,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    ...(record.context || {})
  }, null, 2);

  const resultText = success
    ? (typeof record.result === 'string' ? record.result : JSON.stringify(record.result, null, 2))
    : '(无结果)';
  card.querySelector('.result').textContent = resultText || '(空字符串)';

  const errorElement = card.querySelector('.error-message');
  if (record.error) {
    errorElement.textContent = record.error;
    errorElement.classList.add('visible');
  }

  const image = card.querySelector('.captcha-image');
  image.src = record.imageData;
  image.addEventListener('load', () => {
    card.querySelector('.dimensions').textContent = `${image.naturalWidth} × ${image.naturalHeight}`;
    if (isClick && Array.isArray(record.result)) addPointMarkers(card, image, record.result);
    if (isClick && record.debugDetails?.detection?.mainAreaBoxes) {
      addDetectionBoxes(card, image, record.debugDetails.detection.mainAreaBoxes);
    }
  });
  image.addEventListener('error', () => {
    card.querySelector('.dimensions').textContent = '图片读取失败';
  });
  if (isClick && record.debugDetails) {
    renderClickDebugDetails(
      card.querySelector('.click-debug-details'),
      record.debugDetails,
      record.context || {}
    );
  }
  return card;
}

function addPointMarkers(card, image, points) {
  const imageWrap = card.querySelector('.image-wrap');
  imageWrap.querySelectorAll('.point-marker').forEach(marker => marker.remove());
  const imageRect = image.getBoundingClientRect();
  const wrapRect = imageWrap.getBoundingClientRect();

  points.forEach((point, index) => {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
    const marker = document.createElement('span');
    marker.className = 'point-marker';
    marker.textContent = String(index + 1);
    marker.style.left = `${imageRect.left - wrapRect.left + point.x * imageRect.width / image.naturalWidth}px`;
    marker.style.top = `${imageRect.top - wrapRect.top + point.y * imageRect.height / image.naturalHeight}px`;
    imageWrap.appendChild(marker);
  });
}

function addDetectionBoxes(card, image, boxes) {
  const imageWrap = card.querySelector('.image-wrap');
  imageWrap.querySelectorAll('.detection-box').forEach(box => box.remove());
  const imageRect = image.getBoundingClientRect();
  const wrapRect = imageWrap.getBoundingClientRect();

  boxes.forEach((box, index) => {
    if (!Array.isArray(box) || box.length < 4) return;
    const [x1, y1, x2, y2] = box.map(Number);
    if (![x1, y1, x2, y2].every(Number.isFinite)) return;
    const overlay = document.createElement('span');
    overlay.className = 'detection-box';
    overlay.style.left = `${imageRect.left - wrapRect.left + x1 * imageRect.width / image.naturalWidth}px`;
    overlay.style.top = `${imageRect.top - wrapRect.top + y1 * imageRect.height / image.naturalHeight}px`;
    overlay.style.width = `${(x2 - x1) * imageRect.width / image.naturalWidth}px`;
    overlay.style.height = `${(y2 - y1) * imageRect.height / image.naturalHeight}px`;
    const label = document.createElement('span');
    label.textContent = `#${index + 1}`;
    overlay.appendChild(label);
    imageWrap.appendChild(overlay);
  });
}

function renderClickDebugDetails(container, details, context) {
  container.hidden = false;
  container.replaceChildren();

  const heading = document.createElement('div');
  heading.className = 'pipeline-heading';
  const title = document.createElement('h3');
  title.textContent = '点选验证码完整识别过程';
  const stage = document.createElement('span');
  stage.textContent = `最终阶段：${details.stage || '未知'}`;
  heading.append(title, stage);
  container.appendChild(heading);

  if (details.failure) {
    const failure = document.createElement('div');
    failure.className = 'pipeline-failure';
    failure.textContent = `失败阶段：${details.failure.stage}；原因：${details.failure.message}`;
    container.appendChild(failure);
  }

  if (details.promptRecognition) {
    container.appendChild(createPromptStage(details.promptRecognition));
  }
  if (details.detection) {
    container.appendChild(createDetectionStage(details.detection, details.original));
  }
  if (Array.isArray(details.candidates) && details.candidates.length > 0) {
    container.appendChild(createCandidatesStage(details));
  }
  if (details.finalAssignment) {
    container.appendChild(createAssignmentStage(details.finalAssignment, context));
  }

  const rawDetails = document.createElement('details');
  rawDetails.className = 'raw-debug-details';
  const summary = document.createElement('summary');
  summary.textContent = '完整原始元数据（图片字段已折叠）';
  const raw = document.createElement('pre');
  raw.className = 'context';
  raw.textContent = JSON.stringify(details, (key, value) => {
    if (typeof value === 'string' && /imageData$/i.test(key)) {
      return `[base64 image, ${value.length} chars]`;
    }
    return value;
  }, 2);
  rawDetails.append(summary, raw);
  container.appendChild(rawDetails);
}

function createPipelineStage(number, title) {
  const section = document.createElement('section');
  section.className = 'pipeline-stage';
  const heading = document.createElement('h4');
  const numberElement = document.createElement('span');
  numberElement.className = 'stage-number';
  numberElement.textContent = String(number);
  const titleElement = document.createElement('span');
  titleElement.textContent = title;
  heading.append(numberElement, titleElement);
  section.appendChild(heading);
  return section;
}

function createDebugImage(imageData, caption) {
  const figure = document.createElement('figure');
  figure.className = 'debug-image-figure';
  const image = document.createElement('img');
  image.alt = caption;
  if (imageData) image.src = imageData;
  const figureCaption = document.createElement('figcaption');
  figureCaption.textContent = caption;
  figure.append(image, figureCaption);
  return figure;
}

function createFacts(items) {
  const list = document.createElement('dl');
  list.className = 'stage-facts';
  for (const [label, value] of items) {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    if (value instanceof Node) description.appendChild(value);
    else description.textContent = value == null ? '-' : String(value);
    row.append(term, description);
    list.appendChild(row);
  }
  return list;
}

function createTargetChips(targets) {
  const chips = document.createElement('span');
  chips.className = 'target-chips';
  for (const target of targets || []) {
    const chip = document.createElement('span');
    chip.className = 'target-chip';
    chip.textContent = target;
    chips.appendChild(chip);
  }
  if (!chips.childElementCount) chips.textContent = '未提取到目标字';
  return chips;
}

function createPromptStage(prompt) {
  const section = createPipelineStage(1, '识别需要依次点击的目标文字');
  const grid = document.createElement('div');
  grid.className = 'stage-grid';
  grid.appendChild(createDebugImage(
    prompt.inputImageData,
    '目标 OCR 实际输入原图（从验证码底部裁剪，未经替换）'
  ));
  const crop = prompt.crop || {};
  const cleaning = prompt.targetCleaning || {};
  const removedLeading = (cleaning.removedLeadingArtifacts || []).join('') || '无';
  const removedTrailing = (cleaning.removedTrailingArtifacts || []).join('') || '无';
  grid.appendChild(createFacts([
    ['模型解码文本', prompt.modelDecodedResult ?? '识别尚未完成'],
    ['中文清洗结果', prompt.cleanedOcrResult ?? '识别尚未完成'],
    ['仅保留汉字', cleaning.chineseOnlyText ?? '-'],
    ['首尾提示字清理', `开头移除：${removedLeading}；结尾移除：${removedTrailing}`],
    ['边缘清理后', cleaning.afterEdgeCleanup ?? '-'],
    ['最终提取目标', createTargetChips(prompt.extractedTargets)],
    ['数量严格校验', cleaning.targetCount == null
      ? '-'
      : `${cleaning.targetCount}/4（${cleaning.isValid ? '通过' : '失败，立即更换验证码'}）`],
    ['模型序列长度', prompt.sequenceLength],
    ['解码索引', Array.isArray(prompt.decodedIndices) ? prompt.decodedIndices.join(', ') : '-'],
    ['裁剪区域', `x=${crop.x}, y=${crop.y}, ${crop.width}×${crop.height}`],
    ['裁剪比例', `${Math.round((prompt.cropRatio || 0) * 100)}%（底部区域）`],
    ['阶段耗时', formatDuration(prompt.durationMs)]
  ]));
  section.appendChild(grid);
  const note = document.createElement('p');
  note.className = 'pipeline-note';
  note.textContent = '固定清洗顺序：仅保留汉字 → 从首尾连续移除飞、丫、依、次、点、击、放、下、谈、百、了、工、亡、已、己 → 严格校验必须剩余四个汉字。不会固定删除前四字；校验失败时立即刷新验证码。';
  section.appendChild(note);
  return section;
}

function createDetectionStage(detection, original) {
  const section = createPipelineStage(2, '在完整验证码原图中检测候选文字');
  section.appendChild(createFacts([
    ['检测模型输入', detection.input || '验证码完整原图'],
    ['原图尺寸', original ? `${original.width} × ${original.height}` : '-'],
    ['全部检测框', detection.totalBoxCount],
    ['主区域候选框', detection.mainAreaBoxCount],
    ['提示区边界 Y', detection.promptBoundaryY],
    ['检测耗时', formatDuration(detection.durationMs)]
  ]));
  const note = document.createElement('p');
  note.className = 'pipeline-note';
  note.textContent = '本记录顶部的验证码完整原图已经叠加蓝色候选框；编号与下方候选图编号一致。提示条区域内的框会被过滤。';
  section.appendChild(note);
  return section;
}

function createCandidatesStage(details) {
  const section = createPipelineStage(3, '逐个裁剪并进行旋转粗筛');
  const assignments = details.finalAssignment?.assignments || [];
  const assignmentByCandidate = new Map(assignments.map(item => [item.candidateIndex, item]));
  const grid = document.createElement('div');
  grid.className = 'candidate-grid';

  for (const candidate of details.candidates) {
    const assignment = assignmentByCandidate.get(candidate.candidateIndex);
    const card = document.createElement('article');
    card.className = `candidate-card${assignment ? ' assigned' : ''}`;
    const head = document.createElement('div');
    head.className = 'candidate-head';
    const title = document.createElement('strong');
    title.textContent = `候选 #${candidate.candidateIndex + 1}`;
    head.appendChild(title);
    if (assignment) {
      const badge = document.createElement('span');
      badge.className = 'assigned-badge';
      badge.textContent = `最终匹配：${assignment.target}（第 ${assignment.order} 个）`;
      head.appendChild(badge);
    }
    card.appendChild(head);

    const images = document.createElement('div');
    images.className = `candidate-images${assignment ? '' : ' single'}`;
    images.appendChild(createDebugImage(candidate.cropImageData, '检测框加边距后的候选字裁剪原图'));
    if (assignment) {
      images.appendChild(createDebugImage(
        assignment.recognitionInputImageData,
        `粗筛直接采用 ${assignment.bestAngle}° 旋转后的 OCR 模型输入图`
      ));
    }
    card.appendChild(images);

    const meta = document.createElement('p');
    meta.className = 'candidate-meta';
    meta.textContent = `检测框 ${formatBox(candidate.detectionBox)} ｜ 裁剪框 ${formatBoxObject(candidate.cropBox)}`
      + ` ｜ 检测分数 ${formatScore(candidate.detectionBox?.[4])}`
      + ` ｜ 类别 ${candidate.detectionBox?.[5] ?? '-'}`
      + ` ｜ 中心 (${candidate.center?.x}, ${candidate.center?.y})`
      + ` ｜ ${formatDuration(candidate.durationMs)} ｜ 状态 ${candidate.status || '-'}`;
    card.appendChild(meta);
    card.appendChild(createScoreTable(candidate, assignment));
    card.appendChild(createRotationInputGallery(candidate.coarseResults || []));
    grid.appendChild(card);
  }

  section.appendChild(grid);
  const note = document.createElement('p');
  note.className = 'pipeline-note';
  note.textContent = '粗筛以 15° 步长遍历 0–345°，每个目标字取得的最高粗筛分数和对应角度会直接用于全局一对一匹配，不再执行精筛。分数是目标字符 logit 与 blank logit 的差值，不是概率；高亮行是最终采用的粗筛结果。';
  section.appendChild(note);
  return section;
}

function createScoreTable(candidate, assignment) {
  const table = document.createElement('table');
  table.className = 'score-table';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['目标', '粗筛分数', '粗筛角度']) {
    const cell = document.createElement('th');
    cell.textContent = label;
    headRow.appendChild(cell);
  }
  head.appendChild(headRow);
  const body = document.createElement('tbody');
  for (let resultIndex = 0; resultIndex < (candidate.coarseResults || []).length; resultIndex++) {
    const coarse = candidate.coarseResults[resultIndex];
    const targetIndex = coarse.targetIndex ?? resultIndex;
    const row = document.createElement('tr');
    if (assignment?.order === targetIndex + 1) row.className = 'selected';
    const values = [
      coarse.target,
      formatScore(coarse.score),
      formatAngle(coarse.bestAngle)
    ];
    for (const value of values) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.appendChild(cell);
    }
    body.appendChild(row);
  }
  table.append(head, body);
  return table;
}

function createRotationInputGallery(results) {
  const wrapper = document.createElement('div');
  wrapper.className = 'rotation-inputs';
  const label = document.createElement('p');
  label.textContent = results.length
    ? '该候选字针对四个目标分别取得最高分时的实际 OCR 输入图：'
    : '该候选字尚未完成粗筛，因此没有旋转输入图。';
  wrapper.appendChild(label);
  const grid = document.createElement('div');
  grid.className = 'rotation-input-grid';
  for (const result of results) {
    grid.appendChild(createDebugImage(
      result.bestInputImageData,
      `${result.order}. ${result.target} ｜ ${formatAngle(result.bestAngle)} ｜ ${formatScore(result.score)}`
    ));
  }
  wrapper.appendChild(grid);
  return wrapper;
}

function createAssignmentStage(assignment, context) {
  const section = createPipelineStage(4, '全局一对一匹配与最终点击坐标');
  const grid = document.createElement('div');
  grid.className = 'assignment-grid';
  const clickYOffset = Number(context?.clickYOffset) || 0;
  for (const item of assignment.assignments || []) {
    const card = document.createElement('div');
    card.className = 'assignment-card';
    const target = document.createElement('strong');
    target.textContent = `${item.order}. ${item.target}`;
    card.appendChild(target);
    for (const value of [
      `候选 #${item.candidateIndex + 1}`,
      `识别中心 (${item.center?.x}, ${item.center?.y})`,
      `实际源图点击 (${item.center?.x}, ${Math.max(0, Number(item.center?.y) + clickYOffset)})`,
      `分数 ${formatScore(item.score)}`,
      `最佳角度 ${formatAngle(item.bestAngle)}`
    ]) {
      const line = document.createElement('p');
      line.textContent = value;
      card.appendChild(line);
    }
    grid.appendChild(card);
  }
  section.appendChild(grid);
  const note = document.createElement('p');
  note.className = 'pipeline-note';
  note.textContent = `总匹配分数：${formatScore(assignment.totalScore)}。当前页面点击 Y 偏移为 ${clickYOffset}px；上方同时列出模型识别中心与应用偏移后的实际源图点击坐标。`;
  section.appendChild(note);
  return section;
}

function formatScore(value) {
  if (value == null || value === '') return '-';
  return Number.isFinite(Number(value)) ? Number(value).toFixed(4) : String(value);
}

function formatAngle(value) {
  if (value == null || value === '') return '-';
  return Number.isFinite(Number(value)) ? `${Number(value)}°` : '-';
}

function formatDuration(value) {
  if (value == null || value === '') return '-';
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)} ms` : '-';
}

function formatBox(box) {
  return Array.isArray(box) ? `[${box.slice(0, 4).join(', ')}]` : '-';
}

function formatBoxObject(box) {
  return box ? `[${box.x1}, ${box.y1}, ${box.x2}, ${box.y2}]` : '-';
}

async function clearRecords() {
  const data = await chrome.storage.local.get(null);
  const keys = Object.keys(data).filter(key => key.startsWith(DEBUG_RECORD_PREFIX));
  if (keys.length > 0) await chrome.storage.local.remove(keys);
  records = [];
  render();
}

function exportRecords() {
  const payload = {
    exportedAt: Date.now(),
    sessionId: currentSessionId,
    records
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `nju-captcha-debug-${Date.now()}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatTime(timestamp, includeMilliseconds = false) {
  const date = new Date(timestamp);
  const base = date.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  return includeMilliseconds
    ? `${base}.${String(date.getMilliseconds()).padStart(3, '0')}`
    : base;
}
