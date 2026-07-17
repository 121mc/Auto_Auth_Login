// ============================================
// NJU Auto Auth Login - Offscreen ONNX Inference
// Ported from Flutter OcrSolverService (ddddocr common_old.onnx & common_det.onnx)
// ============================================

(function () {
  'use strict';

  let sessionOcr = null;
  let sessionDet = null;
  let charset = null;
  let charsetPromise = null;
  let ocrSessionPromise = null;
  let detSessionPromise = null;

  // Configure ONNX Runtime
  ort.env.wasm.wasmPaths = chrome.runtime.getURL('lib/');
  ort.env.wasm.numThreads = 1; // Avoid SharedArrayBuffer issues in extension

  // --- Load only the resources required by the current captcha type ---
  async function loadCharset() {
    if (charset) return;
    if (!charsetPromise) {
      charsetPromise = (async () => {
        const charsetUrl = chrome.runtime.getURL('models/charset_old.json');
        const response = await fetch(charsetUrl);
        if (!response.ok) throw new Error(`字符集加载失败: ${response.status}`);
        charset = await response.json();
        console.log(`[ONNX] Charset loaded: ${charset.length} characters`);
      })();
    }
    try {
      await charsetPromise;
    } catch (err) {
      charsetPromise = null;
      throw err;
    }
  }

  async function loadOcrSession() {
    if (sessionOcr) return;
    if (!ocrSessionPromise) {
      ocrSessionPromise = (async () => {
        const modelUrl = chrome.runtime.getURL('models/common_old.onnx');
        const response = await fetch(modelUrl);
        if (!response.ok) throw new Error(`OCR 模型加载失败: ${response.status}`);
        sessionOcr = await ort.InferenceSession.create(await response.arrayBuffer(), {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all'
        });
        console.log('[ONNX] OCR model loaded successfully');
      })();
    }
    try {
      await ocrSessionPromise;
    } catch (err) {
      ocrSessionPromise = null;
      throw err;
    }
  }

  async function loadDetSession() {
    if (sessionDet) return;
    if (!detSessionPromise) {
      detSessionPromise = (async () => {
        const modelUrl = chrome.runtime.getURL('models/common_det.onnx');
        const response = await fetch(modelUrl);
        if (!response.ok) throw new Error(`检测模型加载失败: ${response.status}`);
        sessionDet = await ort.InferenceSession.create(await response.arrayBuffer(), {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all'
        });
        console.log('[ONNX] Detection model loaded successfully');
      })();
    }
    try {
      await detSessionPromise;
    } catch (err) {
      detSessionPromise = null;
      throw err;
    }
  }

  // --- Run the OCR model and expose its sequence logits ---
  async function runOcrInference(imageData) {
    await Promise.all([loadCharset(), loadOcrSession()]);

    const { width: origWidth, height: origHeight, data: pixels } = imageData;

    const targetHeight = 64;
    const targetWidth = Math.max(1, Math.round(origWidth * (targetHeight / origHeight)));

    const resizedData = resizeImage(pixels, origWidth, origHeight, targetWidth, targetHeight);
    const inputTensorData = new Float32Array(targetWidth * targetHeight);

    for (let y = 0; y < targetHeight; y++) {
      for (let x = 0; x < targetWidth; x++) {
        const idx = (y * targetWidth + x) * 4;
        const r = resizedData[idx];
        const g = resizedData[idx + 1];
        const b = resizedData[idx + 2];

        // Grayscale: 0.299R + 0.587G + 0.114B
        const grayscale = r * 0.299 + g * 0.587 + b * 0.114;

        // common_old.onnx is trained with grayscale pixels normalized to [0, 1].
        // Centering them to [-1, 1] substantially reduces recognition accuracy,
        // especially for the small coloured characters in click captchas.
        const normalized = grayscale / 255.0;
        inputTensorData[y * targetWidth + x] = normalized;
      }
    }

    const inputTensor = new ort.Tensor('float32', inputTensorData, [1, 1, targetHeight, targetWidth]);
    const inputName = sessionOcr.inputNames[0];
    const feeds = {};
    feeds[inputName] = inputTensor;
    const results = await sessionOcr.run(feeds);
    const outputName = sessionOcr.outputNames.includes('387') ? '387' : sessionOcr.outputNames[0];
    const outputTensor = results[outputName];
    const outputData = outputTensor.data;
    const numClasses = charset.length;
    const seqLen = Math.floor(outputData.length / numClasses);

    return { outputData, numClasses, seqLen };
  }

  // --- Solve OCR captcha ---
  async function solveCaptcha(imageDataBase64, isChinese = false) {
    const imageData = await decodeImage(imageDataBase64);
    console.log(`[ONNX OCR] Input image: ${imageData.width}x${imageData.height}, isChinese: ${isChinese}`);

    const { outputData, numClasses, seqLen } = await runOcrInference(imageData);
    if (seqLen === 0) return '';

    const predictedIndices = [];
    for (let i = 0; i < seqLen; i++) {
      let argMax = 0;
      let maxVal = outputData[i * numClasses];
      for (let c = 1; c < numClasses; c++) {
        const val = outputData[i * numClasses + c];
        if (val > maxVal) {
          maxVal = val;
          argMax = c;
        }
      }
      predictedIndices.push(argMax);
    }

    const decodedIndices = [];
    let prevIdx = null;
    for (const idx of predictedIndices) {
      if (idx !== prevIdx) {
        if (idx !== 0) {
          decodedIndices.push(idx);
        }
        prevIdx = idx;
      }
    }

    let result = '';
    for (const idx of decodedIndices) {
      if (idx >= 0 && idx < charset.length) {
        result += charset[idx];
      }
    }

    // Clean result
    // If it's Chinese target/click captcha, keep only Chinese. Otherwise alphanumeric.
    const cleaned = isChinese
      ? result.trim().replace(/[^\u4e00-\u9fa5]/g, '')
      : result.trim().replace(/[^a-zA-Z0-9]/g, '');

    console.log(`[ONNX OCR] Raw: "${result}", Cleaned: "${cleaned}"`);
    return cleaned;
  }

  // --- YOLO detection post-processing grids ---
  let detectionGrids = null;
  let detectionExpandedStrides = null;

  function getDetectionGridsAndStrides() {
    if (detectionGrids && detectionExpandedStrides) {
      return { grids: detectionGrids, strides: detectionExpandedStrides };
    }

    const strides = [8, 16, 32];
    const grids = [];
    const expandedStrides = [];

    for (const stride of strides) {
      const hsize = Math.floor(416 / stride);
      const wsize = Math.floor(416 / stride);
      for (let y = 0; y < hsize; y++) {
        for (let x = 0; x < wsize; x++) {
          grids.push([x, y]);
          expandedStrides.push(stride);
        }
      }
    }

    detectionGrids = grids;
    detectionExpandedStrides = expandedStrides;
    return { grids, strides: expandedStrides };
  }

  // --- IoU ---
  function iou(boxA, boxB) {
    const xA = Math.max(boxA[0], boxB[0]);
    const yA = Math.max(boxA[1], boxB[1]);
    const xB = Math.min(boxA[2], boxB[2]);
    const yB = Math.min(boxA[3], boxB[3]);

    const interArea = Math.max(0, xB - xA + 1) * Math.max(0, yB - yA + 1);
    const boxAArea = (boxA[2] - boxA[0] + 1) * (boxA[3] - boxA[1] + 1);
    const boxBArea = (boxB[2] - boxB[0] + 1) * (boxB[3] - boxB[1] + 1);

    return interArea / (boxAArea + boxBArea - interArea);
  }

  // --- NMS ---
  function nms(boxes, nms_thr) {
    const sorted = boxes.slice().sort((a, b) => b[4] - a[4]);
    const keep = [];
    while (sorted.length > 0) {
      const curr = sorted.shift();
      keep.push(curr);
      for (let i = sorted.length - 1; i >= 0; i--) {
        const item = sorted[i];
        if (iou(curr, item) > nms_thr) {
          sorted.splice(i, 1);
        }
      }
    }
    return keep;
  }

  // --- Run Target Detection ---
  async function runTargetDetection(imageData) {
    await loadDetSession();
    const { width: origWidth, height: origHeight } = imageData;

    console.log(`[ONNX Det] Running target detection on image: ${origWidth}x${origHeight}`);

    const ratio = Math.min(416 / origHeight, 416 / origWidth);
    const targetW = Math.round(origWidth * ratio);
    const targetH = Math.round(origHeight * ratio);

    const canvas = document.createElement('canvas');
    canvas.width = 416;
    canvas.height = 416;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgb(114, 114, 114)';
    ctx.fillRect(0, 0, 416, 416);

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = origWidth;
    tempCanvas.height = origHeight;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.putImageData(imageData, 0, 0);

    ctx.drawImage(tempCanvas, 0, 0, origWidth, origHeight, 0, 0, targetW, targetH);

    const detImgData = ctx.getImageData(0, 0, 416, 416).data;

    // Convert RGBA to BGR CHW Float32Array (0-255 range)
    const inputTensorData = new Float32Array(3 * 416 * 416);
    for (let c = 0; c < 3; c++) {
      for (let y = 0; y < 416; y++) {
        for (let x = 0; x < 416; x++) {
          const srcIdx = (y * 416 + x) * 4;
          const dstIdx = c * 416 * 416 + y * 416 + x;
          if (c === 0) {
            inputTensorData[dstIdx] = detImgData[srcIdx + 2]; // B
          } else if (c === 1) {
            inputTensorData[dstIdx] = detImgData[srcIdx + 1]; // G
          } else {
            inputTensorData[dstIdx] = detImgData[srcIdx];     // R
          }
        }
      }
    }

    const inputTensor = new ort.Tensor('float32', inputTensorData, [1, 3, 416, 416]);

    const inputName = sessionDet.inputNames[0];
    const feeds = {};
    feeds[inputName] = inputTensor;

    const results = await sessionDet.run(feeds);
    const outputName = sessionDet.outputNames[0];
    const outputTensor = results[outputName];
    const outputData = outputTensor.data;

    const colLen = outputTensor.dims[2];
    const numPredictions = outputTensor.dims[1]; // 3549

    const { grids, strides } = getDetectionGridsAndStrides();

    const candidateBoxes = [];
    const scoreThr = 0.1;
    const nmsThr = 0.45;

    for (let i = 0; i < numPredictions; i++) {
      const base = i * colLen;
      const objScore = outputData[base + 4];

      let maxClassProb = -Infinity;
      let classId = -1;
      for (let c = 0; c < colLen - 5; c++) {
        const prob = outputData[base + 5 + c];
        if (prob > maxClassProb) {
          maxClassProb = prob;
          classId = c;
        }
      }

      const score = objScore * maxClassProb;
      if (score > scoreThr) {
        const x_center = (outputData[base] + grids[i][0]) * strides[i];
        const y_center = (outputData[base + 1] + grids[i][1]) * strides[i];
        const w = Math.exp(outputData[base + 2]) * strides[i];
        const h = Math.exp(outputData[base + 3]) * strides[i];

        const x1 = (x_center - w / 2) / ratio;
        const y1 = (y_center - h / 2) / ratio;
        const x2 = (x_center + w / 2) / ratio;
        const y2 = (y_center + h / 2) / ratio;

        const x_min = Math.max(0, Math.min(origWidth, Math.round(x1)));
        const y_min = Math.max(0, Math.min(origHeight, Math.round(y1)));
        const x_max = Math.max(0, Math.min(origWidth, Math.round(x2)));
        const y_max = Math.max(0, Math.min(origHeight, Math.round(y2)));

        candidateBoxes.push([x_min, y_min, x_max, y_max, score, classId]);
      }
    }

    const finalBoxes = nms(candidateBoxes, nmsThr);
    console.log(`[ONNX Det] Found ${finalBoxes.length} objects after NMS`);
    return finalBoxes.map(b => b.slice(0, 4));
  }

  // --- Crop a region from ImageData and return as Base64 ---
  function cropImageToBase64(imageData, x, y, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = imageData.width;
    tempCanvas.height = imageData.height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.putImageData(imageData, 0, 0);

    ctx.drawImage(tempCanvas, x, y, width, height, 0, 0, width, height);
    return canvas.toDataURL('image/png');
  }

  function cropImageData(imageData, x1, y1, x2, y2) {
    const left = Math.max(0, Math.floor(x1));
    const top = Math.max(0, Math.floor(y1));
    const right = Math.min(imageData.width, Math.ceil(x2));
    const bottom = Math.min(imageData.height, Math.ceil(y2));
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);

    const source = document.createElement('canvas');
    source.width = imageData.width;
    source.height = imageData.height;
    source.getContext('2d').putImageData(imageData, 0, 0);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, left, top, width, height, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  }

  function getImageBackgroundColor(imageData) {
    const { width, height, data } = imageData;
    const points = [
      [0, 0],
      [Math.max(0, width - 1), 0],
      [0, Math.max(0, height - 1)],
      [Math.max(0, width - 1), Math.max(0, height - 1)]
    ];
    const sum = [0, 0, 0];
    for (const [x, y] of points) {
      const index = (y * width + x) * 4;
      sum[0] += data[index];
      sum[1] += data[index + 1];
      sum[2] += data[index + 2];
    }
    return sum.map(value => Math.round(value / points.length));
  }

  function rotateImageData(imageData, angleDegrees) {
    if (angleDegrees % 360 === 0) return imageData;

    const source = document.createElement('canvas');
    source.width = imageData.width;
    source.height = imageData.height;
    source.getContext('2d').putImageData(imageData, 0, 0);

    const diagonal = Math.ceil(Math.sqrt(imageData.width ** 2 + imageData.height ** 2));
    const canvas = document.createElement('canvas');
    canvas.width = diagonal;
    canvas.height = diagonal;
    const ctx = canvas.getContext('2d');
    const [r, g, b] = getImageBackgroundColor(imageData);
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(0, 0, diagonal, diagonal);
    ctx.translate(diagonal / 2, diagonal / 2);
    ctx.rotate(angleDegrees * Math.PI / 180);
    ctx.drawImage(source, -imageData.width / 2, -imageData.height / 2);
    return ctx.getImageData(0, 0, diagonal, diagonal);
  }

  function extractClickTargets(ocrText) {
    const chinese = ocrText.replace(/[^\u4e00-\u9fff]/g, '');
    const markers = ['依次点击', '点击', '击', '点'];

    for (const marker of markers) {
      const markerIndex = chinese.indexOf(marker);
      if (markerIndex !== -1) {
        const payload = chinese.slice(markerIndex + marker.length);
        if (payload.length >= 4) {
          // Take the first four characters after the prompt. Taking the last
          // four can include a closing bracket OCR misreads as Chinese.
          return payload.slice(0, 4);
        }
      }
    }

    // The fixed prefix 依次点击 is four Chinese characters.
    if (chinese.length >= 8) return chinese.slice(4, 8);
    return chinese.slice(0, 4);
  }

  function scoreTargetsFromOutput(outputData, numClasses, seqLen, targetIndices) {
    return targetIndices.map(targetIndex => {
      let bestScore = -Infinity;
      for (let step = 0; step < seqLen; step++) {
        const base = step * numClasses;
        // Target-vs-blank logit scoring works better for constrained matching
        // than requiring the target to beat all 8210 possible characters.
        const score = outputData[base + targetIndex] - outputData[base];
        if (score > bestScore) bestScore = score;
      }
      return bestScore;
    });
  }

  async function scoreRotatedCandidate(candidateImage, targetIndices, angles) {
    const bestScores = targetIndices.map(() => -Infinity);
    const bestAngles = targetIndices.map(() => 0);
    const results = new Array(angles.length);
    const concurrency = Math.min(4, angles.length);
    let nextIndex = 0;

    async function worker() {
      while (true) {
        const index = nextIndex++;
        if (index >= angles.length) return;

        const angle = angles[index];
        const rotated = rotateImageData(candidateImage, angle);
        const inference = await runOcrInference(rotated);
        results[index] = {
          angle,
          scores: scoreTargetsFromOutput(
            inference.outputData,
            inference.numClasses,
            inference.seqLen,
            targetIndices
          )
        };
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    for (const result of results) {
      for (let targetIndex = 0; targetIndex < result.scores.length; targetIndex++) {
        if (result.scores[targetIndex] > bestScores[targetIndex]) {
          bestScores[targetIndex] = result.scores[targetIndex];
          bestAngles[targetIndex] = result.angle;
        }
      }
    }

    return { scores: bestScores, angles: bestAngles };
  }

  function findBestTargetAssignment(candidates, targetCount) {
    let best = null;

    function search(targetIndex, usedBoxes, assignments, score) {
      if (targetIndex === targetCount) {
        if (!best || score > best.score) {
          best = { score, assignments: assignments.slice() };
        }
        return;
      }

      for (let boxIndex = 0; boxIndex < candidates.length; boxIndex++) {
        if (usedBoxes.has(boxIndex)) continue;
        usedBoxes.add(boxIndex);
        assignments.push(boxIndex);
        search(
          targetIndex + 1,
          usedBoxes,
          assignments,
          score + candidates[boxIndex].scores[targetIndex]
        );
        assignments.pop();
        usedBoxes.delete(boxIndex);
      }
    }

    search(0, new Set(), [], 0);
    return best;
  }

  // --- Solve Click Captcha ---
  async function solveClickCaptcha(imageDataBase64) {
    await Promise.all([loadCharset(), loadOcrSession(), loadDetSession()]);

    // 1. Decode main image
    const imageData = await decodeImage(imageDataBase64);
    const { width: origWidth, height: origHeight } = imageData;

    console.log(`[ONNX Click] Captcha image decoded: ${origWidth}x${origHeight}`);

    // 2. Crop the bottom bar (prompt text)
    // The black bar is at the bottom. Typically bottom 28% of the image.
    const barHeight = Math.round(origHeight * 0.28);
    const barY = origHeight - barHeight;
    const barBase64 = cropImageToBase64(imageData, 0, barY, origWidth, barHeight);

    // 3. Solve OCR on the bottom bar to get prompt characters (allow Chinese)
    const ocrRawResult = await solveCaptcha(barBase64, true);
    console.log(`[ONNX Click] Bottom bar raw OCR: "${ocrRawResult}"`);

    // Extract the first four characters after the fixed prompt. This avoids
    // treating the closing bracket as a target when OCR reads it as 丫.
    const targets = extractClickTargets(ocrRawResult);
    console.log(`[ONNX Click] Target characters to click in order: "${targets}"`);

    if (targets.length !== 4) {
      throw new Error(`未能识别出4个目标字符，识别到: "${targets}"`);
    }

    // 4. Run target detection on the full image
    const boxes = await runTargetDetection(imageData);

    // Filter boxes in the main area (above the bottom bar)
    const mainBoxes = boxes.filter(box => {
      const y2 = box[3];
      return y2 < barY;
    });

    console.log(`[ONNX Click] Filtered boxes: ${mainBoxes.length} boxes in main area`);

    if (mainBoxes.length < 4) {
      throw new Error(`目标检测只找到 ${mainBoxes.length} 个候选字，至少需要4个`);
    }

    const targetIndices = Array.from(targets).map(char => charset.indexOf(char));
    if (targetIndices.some(index => index < 0)) {
      throw new Error(`目标字符不在OCR字符集中: ${targets}`);
    }

    // 5. Score every box against only the four requested characters while
    // rotating each crop to compensate for random glyph orientation.
    const coarseAngles = [];
    for (let angle = 0; angle < 360; angle += 20) coarseAngles.push(angle);
    const rotationCandidates = [];

    for (const box of mainBoxes) {
      const [x1, y1, x2, y2] = box;
      const w = x2 - x1;
      const h = y2 - y1;
      const padding = Math.max(2, Math.round(Math.max(w, h) * 0.15));
      const candidateImage = cropImageData(
        imageData,
        x1 - padding,
        y1 - padding,
        x2 + padding,
        Math.min(barY, y2 + padding)
      );
      const rotationScores = await scoreRotatedCandidate(
        candidateImage,
        targetIndices,
        coarseAngles
      );
      rotationCandidates.push({
        imageData: candidateImage,
        scores: rotationScores.scores,
        angles: rotationScores.angles,
        center: {
          x: Math.round(x1 + w / 2),
          y: Math.round(y1 + h / 2)
        }
      });
    }

    // Refine ±15° around each best coarse angle.
    for (const candidate of rotationCandidates) {
      const refineAngles = new Set();
      for (const angle of candidate.angles) {
        refineAngles.add((angle + 345) % 360);
        refineAngles.add((angle + 15) % 360);
      }
      const refined = await scoreRotatedCandidate(
        candidate.imageData,
        targetIndices,
        Array.from(refineAngles)
      );
      for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
        if (refined.scores[targetIndex] > candidate.scores[targetIndex]) {
          candidate.scores[targetIndex] = refined.scores[targetIndex];
          candidate.angles[targetIndex] = refined.angles[targetIndex];
        }
      }
    }

    const rotationAssignment = findBestTargetAssignment(rotationCandidates, targets.length);
    if (!rotationAssignment) {
      throw new Error(`无法为目标字符建立一一匹配: ${targets}`);
    }

    const assignedScores = rotationAssignment.assignments.map(
      (boxIndex, targetIndex) => rotationCandidates[boxIndex].scores[targetIndex]
    );
    const scoreSummary = rotationAssignment.assignments.map((boxIndex, targetIndex) => {
      const candidate = rotationCandidates[boxIndex];
      return `${targets[targetIndex]}@(${candidate.center.x},${candidate.center.y})`
        + `=${candidate.scores[targetIndex].toFixed(2)}/${candidate.angles[targetIndex]}°`;
    }).join(`, `);
    console.log(`[ONNX Click] Rotation-aware assignment: ${scoreSummary}`);

    if (assignedScores.some(score => !Number.isFinite(score) || score <= 0)) {
      throw new Error(`旋转识别置信度不足. 目标: ${targets}, 匹配: ${scoreSummary}`);
    }

    const rotationClickCoords = rotationAssignment.assignments.map(
      boxIndex => rotationCandidates[boxIndex].center
    );
    console.log(`[ONNX Click] Successfully matched coordinates:`, rotationClickCoords);
    return rotationClickCoords;
  }

  // --- Decode base64 image using canvas ---
  function decodeImage(base64Data) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.getElementById('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, img.width, img.height);
        resolve(imageData);
      };
      img.onerror = reject;
      img.src = base64Data;
    });
  }

  // --- Bilinear interpolation resize ---
  function resizeImage(srcPixels, srcW, srcH, dstW, dstH) {
    const dst = new Uint8ClampedArray(dstW * dstH * 4);

    const xRatio = srcW / dstW;
    const yRatio = srcH / dstH;

    for (let y = 0; y < dstH; y++) {
      for (let x = 0; x < dstW; x++) {
        const srcX = x * xRatio;
        const srcY = y * yRatio;

        const x0 = Math.floor(srcX);
        const y0 = Math.floor(srcY);
        const x1 = Math.min(x0 + 1, srcW - 1);
        const y1 = Math.min(y0 + 1, srcH - 1);

        const xLerp = srcX - x0;
        const yLerp = srcY - y0;

        const dstIdx = (y * dstW + x) * 4;

        for (let c = 0; c < 4; c++) {
          const topLeft = srcPixels[(y0 * srcW + x0) * 4 + c];
          const topRight = srcPixels[(y0 * srcW + x1) * 4 + c];
          const bottomLeft = srcPixels[(y1 * srcW + x0) * 4 + c];
          const bottomRight = srcPixels[(y1 * srcW + x1) * 4 + c];

          const top = topLeft + (topRight - topLeft) * xLerp;
          const bottom = bottomLeft + (bottomRight - bottomLeft) * xLerp;
          dst[dstIdx + c] = Math.round(top + (bottom - top) * yLerp);
        }
      }
    }

    return dst;
  }

  // --- Message listener ---
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'offscreen_solveCaptcha') {
      solveCaptcha(message.imageData, false)
        .then(result => {
          sendResponse({ result });
        })
        .catch(err => {
          console.error('[ONNX] Solve failed:', err);
          sendResponse({ error: err.message });
        });
      return true; // Keep message channel open
    }

    if (message.action === 'offscreen_solveClickCaptcha') {
      solveClickCaptcha(message.imageData)
        .then(result => {
          sendResponse({ result });
        })
        .catch(err => {
          console.error('[ONNX Click] Solve failed:', err);
          sendResponse({ error: err.message });
        });
      return true; // Keep message channel open
    }
  });

  console.log('[ONNX] Offscreen document ready');
})();
