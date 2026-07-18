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
  async function solveCaptcha(imageDataBase64, isChinese = false, includeDebugDetails = false) {
    const imageData = await decodeImage(imageDataBase64);
    console.log(`[ONNX OCR] Input image: ${imageData.width}x${imageData.height}, isChinese: ${isChinese}`);

    const { outputData, numClasses, seqLen } = await runOcrInference(imageData);
    if (seqLen === 0) {
      return includeDebugDetails ? {
        modelDecodedResult: '',
        cleanedResult: '',
        sequenceLength: 0,
        predictedIndices: [],
        decodedIndices: []
      } : '';
    }

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
    if (includeDebugDetails) {
      return {
        modelDecodedResult: result.trim(),
        cleanedResult: cleaned,
        sequenceLength: seqLen,
        predictedIndices,
        decodedIndices
      };
    }
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
    // Preserve score and class id for Debug mode. Callers that only need the
    // rectangle continue to destructure the first four values.
    return finalBoxes.map(box => box.slice());
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

  function imageDataToBase64(imageData) {
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    canvas.getContext('2d').putImageData(imageData, 0, 0);
    return canvas.toDataURL('image/png');
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

  function cleanClickTargetText(ocrText) {
    const isHanCharacter = char => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(char);
    const edgeArtifacts = new Set([
      '飞', '丫', '依', '次', '点', '击', '放', '下', '谈', '百', '了', '工', '亡',
      '已', '己'
    ]);
    const chineseCharacters = Array.from(ocrText || '').filter(isHanCharacter);
    const remainingCharacters = chineseCharacters.slice();
    const removedLeadingArtifacts = [];
    const removedTrailingArtifacts = [];

    // Remove prompt characters and common bracket OCR artifacts only while
    // they appear at either edge. Characters inside the payload are retained.
    while (remainingCharacters.length > 0 && edgeArtifacts.has(remainingCharacters[0])) {
      removedLeadingArtifacts.push(remainingCharacters.shift());
    }
    while (remainingCharacters.length > 0 && edgeArtifacts.has(remainingCharacters.at(-1))) {
      removedTrailingArtifacts.unshift(remainingCharacters.pop());
    }

    const targets = remainingCharacters.join('');
    return {
      chineseOnlyText: chineseCharacters.join(''),
      removedLeadingArtifacts,
      removedTrailingArtifacts,
      afterEdgeCleanup: targets,
      targets,
      targetCount: remainingCharacters.length,
      isValid: remainingCharacters.length === 4
    };
  }

  function scoreTargetsFromOutput(outputData, numClasses, seqLen, targetIndices) {
    return targetIndices.map(targetIndex => {
      let bestScore = -Infinity;
      for (let step = 0; step < seqLen; step++) {
        const base = step * numClasses;
        const score = outputData[base + targetIndex] - outputData[base];
        if (score > bestScore) bestScore = score;
      }
      return bestScore;
    });
  }

  async function scoreRotatedCandidateSerial(candidateImage, targetIndices, angles) {
    const bestScores = targetIndices.map(() => -Infinity);
    const bestAngles = targetIndices.map(() => 0);

    for (const angle of angles) {
      const rotated = rotateImageData(candidateImage, angle);
      const inference = await runOcrInference(rotated);
      const scores = scoreTargetsFromOutput(
        inference.outputData,
        inference.numClasses,
        inference.seqLen,
        targetIndices
      );
      for (let targetIndex = 0; targetIndex < scores.length; targetIndex++) {
        if (scores[targetIndex] > bestScores[targetIndex]) {
          bestScores[targetIndex] = scores[targetIndex];
          bestAngles[targetIndex] = angle;
        }
      }
    }

    return { scores: bestScores, angles: bestAngles };
  }

  async function scoreRotatedCandidate(candidateImage, targetIndices, angles) {
    return scoreRotatedCandidateSerial(candidateImage, targetIndices, angles);
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
  async function solveClickCaptcha(imageDataBase64, captureDebug = false) {
    const totalStartedAt = performance.now();
    let currentStage = '模型加载';
    const debugDetails = captureDebug ? {
      schemaVersion: 1,
      stage: currentStage,
      original: null,
      promptRecognition: null,
      detection: null,
      candidates: [],
      finalAssignment: null,
      timings: {},
      configuration: {
        promptOcr: {
          model: 'models/common_old.onnx',
          charset: 'models/charset_old.json',
          input: '底部 28% 提示条裁剪图',
          preprocessing: '等比缩放到高度 64，灰度化，像素归一化到 [0,1]',
          decoding: 'CTC 去重与去 blank，仅保留中文字符',
          targetCleaning: '仅保留汉字；从首尾连续移除飞/丫/依/次/点/击/放/下/谈/百/了/工/亡/已/己；必须恰好剩余四字'
        },
        targetDetection: {
          model: 'models/common_det.onnx',
          inputSize: '416×416',
          preprocessing: '保持宽高比缩放，BGR CHW，填充色 RGB(114,114,114)',
          scoreThreshold: 0.1,
          nmsThreshold: 0.45
        },
        candidateRecognition: {
          cropPaddingRatio: 0.15,
          minimumPaddingPx: 2,
          coarseAngles: '0°–345°，步长 15°',
          scoreDefinition: '目标字符 logit 减去 blank logit',
          assignment: '所有目标字与候选框的最高总分一对一匹配'
        }
      }
    } : null;

    try {
      const modelStartedAt = performance.now();
      await Promise.all([loadCharset(), loadOcrSession(), loadDetSession()]);
      if (debugDetails) {
        debugDetails.timings.modelReadyMs = Math.round((performance.now() - modelStartedAt) * 10) / 10;
      }

      // 1. Decode main image
      currentStage = '验证码原图解码';
      if (debugDetails) debugDetails.stage = currentStage;
      const imageData = await decodeImage(imageDataBase64);
      const { width: origWidth, height: origHeight } = imageData;
      if (debugDetails) debugDetails.original = { width: origWidth, height: origHeight };

      console.log(`[ONNX Click] Captcha image decoded: ${origWidth}x${origHeight}`);

      // 2. Crop the bottom bar (prompt text)
      // The black bar is at the bottom. Typically bottom 28% of the image.
      currentStage = '目标文字识别';
      if (debugDetails) debugDetails.stage = currentStage;
      const promptStartedAt = performance.now();
      const barHeight = Math.round(origHeight * 0.28);
      const barY = origHeight - barHeight;
      const barBase64 = cropImageToBase64(imageData, 0, barY, origWidth, barHeight);
      if (debugDetails) {
        debugDetails.promptRecognition = {
          inputImageData: barBase64,
          crop: { x: 0, y: barY, width: origWidth, height: barHeight },
          cropRatio: 0.28,
          modelDecodedResult: null,
          cleanedOcrResult: null,
          sequenceLength: null,
          predictedIndices: null,
          decodedIndices: null,
          targetCleaning: null,
          extractedTargets: null,
          durationMs: null
        };
      }

      // 3. Solve OCR on the exact bottom-bar crop to get prompt characters.
      const promptOcrOutput = await solveCaptcha(barBase64, true, captureDebug);
      const cleanedOcrText = captureDebug
        ? promptOcrOutput.cleanedResult
        : promptOcrOutput;
      console.log(`[ONNX Click] Bottom bar cleaned OCR: "${cleanedOcrText}"`);

      const targetCleaning = cleanClickTargetText(cleanedOcrText);
      const targets = targetCleaning.targets;
      console.log(`[ONNX Click] Target characters to click in order: "${targets}"`);
      if (debugDetails) {
        debugDetails.promptRecognition.modelDecodedResult = promptOcrOutput.modelDecodedResult;
        debugDetails.promptRecognition.cleanedOcrResult = promptOcrOutput.cleanedResult;
        debugDetails.promptRecognition.sequenceLength = promptOcrOutput.sequenceLength;
        debugDetails.promptRecognition.predictedIndices = promptOcrOutput.predictedIndices;
        debugDetails.promptRecognition.decodedIndices = promptOcrOutput.decodedIndices;
        debugDetails.promptRecognition.targetCleaning = targetCleaning;
        debugDetails.promptRecognition.extractedTargets = Array.from(targets);
        debugDetails.promptRecognition.durationMs = Math.round((performance.now() - promptStartedAt) * 10) / 10;
      }

      if (!targetCleaning.isValid) {
        throw new Error(
          `目标文字清洗后必须正好为4个汉字，当前为 ${targetCleaning.targetCount} 个: "${targets}"`
        );
      }

      // 4. Run target detection on the full image.
      currentStage = '候选文字检测';
      if (debugDetails) debugDetails.stage = currentStage;
      const detectionStartedAt = performance.now();
      const boxes = await runTargetDetection(imageData);

      // Filter boxes in the main area (above the bottom bar).
      const mainBoxes = boxes.filter(box => {
        const y2 = box[3];
        return y2 < barY;
      });
      if (debugDetails) {
        debugDetails.detection = {
          input: '验证码完整原图',
          boxFormat: '[x1, y1, x2, y2, score, classId]',
          promptBoundaryY: barY,
          allBoxes: boxes.map(box => box.slice()),
          mainAreaBoxes: mainBoxes.map(box => box.slice()),
          totalBoxCount: boxes.length,
          mainAreaBoxCount: mainBoxes.length,
          durationMs: Math.round((performance.now() - detectionStartedAt) * 10) / 10
        };
      }

      console.log(`[ONNX Click] Filtered boxes: ${mainBoxes.length} boxes in main area`);

      if (mainBoxes.length < 4) {
        throw new Error(`目标检测只找到 ${mainBoxes.length} 个候选字，至少需要4个`);
      }

      const targetIndices = Array.from(targets).map(char => charset.indexOf(char));
      if (targetIndices.some(index => index < 0)) {
        throw new Error(`目标字符不在OCR字符集中: ${targets}`);
      }

      // 5. Score every detected crop against the four target characters while
      // rotating each crop to compensate for random glyph orientation.
      currentStage = '候选字旋转识别';
      if (debugDetails) debugDetails.stage = currentStage;
      const scoringStartedAt = performance.now();
      const coarseAngles = [];
      for (let angle = 0; angle < 360; angle += 15) coarseAngles.push(angle);
      const rotationCandidates = [];

      for (let candidateIndex = 0; candidateIndex < mainBoxes.length; candidateIndex++) {
        const box = mainBoxes[candidateIndex];
        const [x1, y1, x2, y2] = box;
        const w = x2 - x1;
        const h = y2 - y1;
        const padding = Math.max(2, Math.round(Math.max(w, h) * 0.15));
        const cropBox = {
          x1: Math.max(0, Math.floor(x1 - padding)),
          y1: Math.max(0, Math.floor(y1 - padding)),
          x2: Math.min(origWidth, Math.ceil(x2 + padding)),
          y2: Math.min(barY, Math.ceil(y2 + padding))
        };
        const candidateImage = cropImageData(
          imageData,
          cropBox.x1,
          cropBox.y1,
          cropBox.x2,
          cropBox.y2
        );
        const candidateStartedAt = performance.now();
        const debugCandidate = captureDebug ? {
          candidateIndex,
          detectionBox: box.slice(),
          cropBox,
          center: {
            x: Math.round(x1 + w / 2),
            y: Math.round(y1 + h / 2)
          },
          cropImageData: imageDataToBase64(candidateImage),
          cropWidth: candidateImage.width,
          cropHeight: candidateImage.height,
          coarseAngleStep: 15,
          coarseResults: null,
          durationMs: null,
          status: '粗筛识别中'
        } : null;
        if (debugCandidate) debugDetails.candidates.push(debugCandidate);

        let rotationScores;
        try {
          rotationScores = await scoreRotatedCandidate(
            candidateImage,
            targetIndices,
            coarseAngles
          );
        } catch (err) {
          if (debugCandidate) {
            debugCandidate.durationMs = Math.round((performance.now() - candidateStartedAt) * 10) / 10;
            debugCandidate.status = `粗筛失败：${err.message || err}`;
          }
          throw err;
        }
        if (debugCandidate) {
          debugCandidate.coarseResults = Array.from(targets).map((target, targetIndex) => ({
            targetIndex,
            order: targetIndex + 1,
            target,
            score: rotationScores.scores[targetIndex],
            bestAngle: rotationScores.angles[targetIndex],
            bestInputImageData: imageDataToBase64(
              rotateImageData(candidateImage, rotationScores.angles[targetIndex])
            )
          }));
          debugCandidate.durationMs = Math.round((performance.now() - candidateStartedAt) * 10) / 10;
          debugCandidate.status = '粗筛完成，直接用于全局匹配';
        }
        rotationCandidates.push({
          scores: rotationScores.scores,
          angles: rotationScores.angles,
          center: {
            x: Math.round(x1 + w / 2),
            y: Math.round(y1 + h / 2)
          }
        });
      }

      if (debugDetails) {
        debugDetails.timings.candidateScoringMs = Math.round((performance.now() - scoringStartedAt) * 10) / 10;
      }

      currentStage = '全局一对一匹配';
      if (debugDetails) debugDetails.stage = currentStage;
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

      const assignments = rotationAssignment.assignments.map((boxIndex, targetIndex) => {
        const candidate = rotationCandidates[boxIndex];
        const angle = candidate.angles[targetIndex];
        return {
          order: targetIndex + 1,
          target: targets[targetIndex],
          candidateIndex: boxIndex,
          center: candidate.center,
          score: candidate.scores[targetIndex],
          bestAngle: angle,
          recognitionInputImageData: captureDebug
            ? debugDetails.candidates[boxIndex].coarseResults[targetIndex].bestInputImageData
            : null
        };
      });
      if (debugDetails) {
        debugDetails.finalAssignment = {
          totalScore: rotationAssignment.score,
          scoreSummary,
          assignments,
          clickCoordinates: assignments.map(assignment => assignment.center)
        };
      }

      if (assignedScores.some(score => !Number.isFinite(score))) {
        throw new Error(`旋转识别分数异常. 目标: ${targets}, 匹配: ${scoreSummary}`);
      }

      const rotationClickCoords = assignments.map(assignment => assignment.center);
      currentStage = '完成';
      if (debugDetails) {
        debugDetails.stage = currentStage;
        debugDetails.timings.totalMs = Math.round((performance.now() - totalStartedAt) * 10) / 10;
      }
      console.log(`[ONNX Click] Successfully matched coordinates:`, rotationClickCoords);
      return { coordinates: rotationClickCoords, debugDetails };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (debugDetails) {
        debugDetails.stage = currentStage;
        debugDetails.failure = { stage: currentStage, message: error.message };
        debugDetails.timings.totalMs = Math.round((performance.now() - totalStartedAt) * 10) / 10;
        error.debugDetails = debugDetails;
      }
      throw error;
    }
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
    if (message.action === 'offscreen_prewarmClickCaptcha') {
      Promise.all([loadCharset(), loadOcrSession(), loadDetSession()])
        .then(() => sendResponse({ ok: true }))
        .catch(err => {
          console.error('[ONNX] Click captcha prewarm failed:', err);
          sendResponse({ error: err.message });
        });
      return true;
    }

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
      solveClickCaptcha(message.imageData, message.captureDebug === true)
        .then(output => {
          sendResponse({ result: output.coordinates, debugDetails: output.debugDetails });
        })
        .catch(err => {
          console.error('[ONNX Click] Solve failed:', err);
          sendResponse({ error: err.message, debugDetails: err.debugDetails || null });
        });
      return true; // Keep message channel open
    }
  });

  console.log('[ONNX] Offscreen document ready');
})();
