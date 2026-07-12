// ============================================
// NJU Auto Auth Login - Offscreen ONNX Inference
// Ported from Flutter OcrSolverService (ddddocr common_old.onnx)
// ============================================

(function () {
  'use strict';

  let session = null;
  let charset = null;
  let initializing = false;
  let initPromise = null;

  // Configure ONNX Runtime
  ort.env.wasm.wasmPaths = chrome.runtime.getURL('lib/');
  ort.env.wasm.numThreads = 1; // Avoid SharedArrayBuffer issues in extension

  // --- Initialize model ---
  async function initialize() {
    if (session && charset) return;
    if (initializing) {
      await initPromise;
      return;
    }

    initializing = true;
    initPromise = (async () => {
      try {
        console.log('[ONNX] Initializing model...');

        // Load charset
        const charsetUrl = chrome.runtime.getURL('models/charset_old.json');
        const charsetResponse = await fetch(charsetUrl);
        charset = await charsetResponse.json();
        console.log(`[ONNX] Charset loaded: ${charset.length} characters`);

        // Load model
        const modelUrl = chrome.runtime.getURL('models/common_old.onnx');
        const modelResponse = await fetch(modelUrl);
        const modelBuffer = await modelResponse.arrayBuffer();

        session = await ort.InferenceSession.create(modelBuffer, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all'
        });

        console.log('[ONNX] Model loaded successfully');
        console.log('[ONNX] Input names:', session.inputNames);
        console.log('[ONNX] Output names:', session.outputNames);
      } catch (err) {
        console.error('[ONNX] Initialization failed:', err);
        throw err;
      } finally {
        initializing = false;
      }
    })();

    await initPromise;
  }

  // --- Solve captcha ---
  async function solveCaptcha(imageDataBase64) {
    await initialize();

    // 1. Decode base64 image to ImageData
    const imageData = await decodeImage(imageDataBase64);
    const { width: origWidth, height: origHeight, data: pixels } = imageData;

    console.log(`[ONNX] Input image: ${origWidth}x${origHeight}`);

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
    const inputName = session.inputNames[0]; // Should be 'input1'
    const feeds = {};
    feeds[inputName] = inputTensor;

    const results = await session.run(feeds);

    // 6. Get output - try known output name '387' first, then fallback to first output
    const outputName = session.outputNames.includes('387') ? '387' : session.outputNames[0];
    const outputTensor = results[outputName];
    const outputData = outputTensor.data;

    console.log(`[ONNX] Output shape: ${outputTensor.dims}, output name: ${outputName}`);

    // 7. CTC Greedy Decoding
    const numClasses = charset.length;
    const seqLen = Math.floor(outputData.length / numClasses);

    if (seqLen === 0) return '';

    // Find argmax for each time step
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

    // CTC decode: remove duplicates and blank (0)
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

    // Map to characters
    let result = '';
    for (const idx of decodedIndices) {
      if (idx >= 0 && idx < charset.length) {
        result += charset[idx];
      }
    }

    // Clean: remove whitespace and non-alphanumeric
    const cleaned = result.trim().replace(/[^a-zA-Z0-9]/g, '');
    console.log(`[ONNX] Raw: "${result}", Cleaned: "${cleaned}"`);

    return cleaned;
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
      solveCaptcha(message.imageData)
        .then(result => {
          sendResponse({ result });
        })
        .catch(err => {
          console.error('[ONNX] Solve failed:', err);
          sendResponse({ error: err.message });
        });
      return true; // Keep message channel open
    }
  });

  console.log('[ONNX] Offscreen document ready');
})();
