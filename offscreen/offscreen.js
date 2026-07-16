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

  // --- Solve OCR captcha ---
  async function solveCaptcha(imageDataBase64, isChinese = false) {
    await Promise.all([loadCharset(), loadOcrSession()]);

    // 1. Decode base64 image to ImageData
    const imageData = await decodeImage(imageDataBase64);
    const { width: origWidth, height: origHeight, data: pixels } = imageData;

    console.log(`[ONNX OCR] Input image: ${origWidth}x${origHeight}, isChinese: ${isChinese}`);

    // 2. Resize to height=64, proportional width
    const targetHeight = 64;
    const targetWidth = Math.round(origWidth * (targetHeight / origHeight));

    // 3. Resize and convert to grayscale normalized tensor
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

        // Normalize: (value / 255.0 - 0.5) / 0.5
        const normalized = (grayscale / 255.0 - 0.5) / 0.5;
        inputTensorData[y * targetWidth + x] = normalized;
      }
    }

    // 4. Create input tensor [1, 1, H, W]
    const inputTensor = new ort.Tensor('float32', inputTensorData, [1, 1, targetHeight, targetWidth]);

    // 5. Run inference
    const inputName = sessionOcr.inputNames[0]; // Should be 'input1'
    const feeds = {};
    feeds[inputName] = inputTensor;

    const results = await sessionOcr.run(feeds);

    // 6. Get output
    const outputName = sessionOcr.outputNames.includes('387') ? '387' : sessionOcr.outputNames[0];
    const outputTensor = results[outputName];
    const outputData = outputTensor.data;

    // 7. CTC Greedy Decoding
    const numClasses = charset.length;
    const seqLen = Math.floor(outputData.length / numClasses);

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

    // Clean and extract the 4 target characters from the end
    const targets = ocrRawResult.slice(-4);
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

    // 5. OCR on each bounding box
    const recognizedCandidates = [];
    for (const box of mainBoxes) {
      const [x1, y1, x2, y2] = box;
      const w = x2 - x1;
      const h = y2 - y1;
      const charBase64 = cropImageToBase64(imageData, x1, y1, w, h);
      const charText = await solveCaptcha(charBase64, true);
      console.log(`[ONNX Click] Box [${x1},${y1},${x2},${y2}] recognized as: "${charText}"`);
      if (charText && charText.length > 0) {
        recognizedCandidates.push({
          box,
          char: charText[0],
          center: {
            x: Math.round(x1 + w / 2),
            y: Math.round(y1 + h / 2)
          }
        });
      }
    }

    // 6. Match candidates to targets in order
    const clickCoords = [];
    const availableCandidates = recognizedCandidates.slice();
    for (let i = 0; i < targets.length; i++) {
      const targetChar = targets[i];
      const matchIndex = availableCandidates.findIndex(c => c.char === targetChar);
      if (matchIndex !== -1) {
        const [match] = availableCandidates.splice(matchIndex, 1);
        clickCoords.push(match.center);
      } else {
        console.warn(`[ONNX Click] Target character "${targetChar}" not matched in candidates`);
      }
    }

    if (clickCoords.length !== 4) {
      throw new Error(`无法完全匹配所有目标字符. 目标: "${targets}", 匹配成功数: ${clickCoords.length}`);
    }

    console.log('[ONNX Click] Successfully matched coordinates:', clickCoords);
    return clickCoords;
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
