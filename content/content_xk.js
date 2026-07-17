// ============================================
// NJU Auto Auth Login - Elective System Click-Captcha Content Script
// Injected into: https://xk.nju.edu.cn/xsxkapp/sys/xsxkapp/*default/index.do
// ============================================

(function () {
  'use strict';

  const MAX_RETRIES = 10;
  let retryCount = 0;
  let isRunning = false;

  // ---- Logging ----
  function log(msg, level = 'info') {
    console.log(`[NJU XK][${level}] ${msg}`);
    chrome.runtime.sendMessage({ action: 'contentLog', msg: `[选课] ${msg}`, level }).catch(() => {});
  }

  // ---- Wait for an element to appear in the DOM ----
  function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) { resolve(el); return; }

      const observer = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) {
          observer.disconnect();
          resolve(found);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timeout waiting for "${selector}"`));
      }, timeout);
    });
  }

  // ---- Wait for a delay ----
  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  const CAPTCHA_CLICK_Y_OFFSET = -11;

  function setInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    ).set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function fillLoginCredentials() {
    const [data, loginNameInput, loginPwdInput] = await Promise.all([
      chrome.storage.local.get(['nju_username', 'nju_password']),
      waitForElement('#loginName', 15000),
      waitForElement('#loginPwd', 15000)
    ]);

    if (!data.nju_username || !data.nju_password) {
      throw new Error('插件中尚未保存学号或密码');
    }

    setInputValue(loginNameInput, data.nju_username);
    setInputValue(loginPwdInput, data.nju_password);
    log('已从插件存储填充学号和密码');

    return {
      username: data.nju_username,
      password: data.nju_password
    };
  }

  // ---- Get the captcha image as a base64 Data URL ----
  function getCaptchaImageBase64() {
    return new Promise((resolve, reject) => {
      const img = document.getElementById('vcodeImg');
      if (!img || !img.src || img.src === window.location.href) {
        reject(new Error('验证码图片未找到或src为空'));
        return;
      }

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      if (img.complete && img.naturalWidth > 0) {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        ctx.drawImage(img, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      } else {
        // Image not yet loaded
        const tmpImg = new Image();
        tmpImg.crossOrigin = 'anonymous';
        tmpImg.onload = () => {
          canvas.width = tmpImg.naturalWidth;
          canvas.height = tmpImg.naturalHeight;
          ctx.drawImage(tmpImg, 0, 0);
          resolve(canvas.toDataURL('image/png'));
        };
        tmpImg.onerror = () => reject(new Error('验证码图片加载失败'));
        tmpImg.src = img.src + (img.src.includes('?') ? '&' : '?') + '_t=' + Date.now();
      }
    });
  }

  // ---- Simulate a click at source-image coordinates (relX, relY) ----
  function simulateClick(element, relX, relY) {
    const rect = element.getBoundingClientRect();
    const sourceWidth = element.naturalWidth;
    const sourceHeight = element.naturalHeight;

    if (!sourceWidth || !sourceHeight || !rect.width || !rect.height) {
      throw new Error('验证码图片尺寸无效，无法换算点击坐标');
    }
    if (!Number.isFinite(relX) || !Number.isFinite(relY) ||
        relX < 0 || relY < 0 || relX >= sourceWidth || relY >= sourceHeight) {
      throw new Error(`验证码坐标越界: (${relX}, ${relY})，原图尺寸: ${sourceWidth}x${sourceHeight}`);
    }

    // The detector works on the image's natural pixels, whereas the page stores
    // event.offsetX/Y in CSS pixels.  Convert before dispatching the click.
    const offsetX = Math.max(0, Math.min(rect.width - 1, relX * rect.width / sourceWidth));
    const offsetY = Math.max(0, Math.min(rect.height - 1, relY * rect.height / sourceHeight));
    const clientX = rect.left + offsetX;
    const clientY = rect.top + offsetY;

    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
      screenX: clientX + window.screenX,
      screenY: clientY + window.screenY,
    };

    ['mousedown', 'mouseup', 'click'].forEach(type => {
      const evt = new MouseEvent(type, opts);
      // The page handler reads offsetX / offsetY, which MouseEventInit cannot set.
      Object.defineProperty(evt, 'offsetX', { value: offsetX, enumerable: true });
      Object.defineProperty(evt, 'offsetY', { value: offsetY, enumerable: true });
      element.dispatchEvent(evt);
    });

    return { x: Math.round(offsetX), y: Math.round(offsetY) };
  }

  // ---- Read/write the state that the page itself submits to the server ----
  function getRecordedCaptchaPoints() {
    try {
      const value = JSON.parse(sessionStorage.getItem('verifyResult') || '[]');
      return Array.isArray(value) ? value : [];
    } catch (_) {
      return [];
    }
  }

  function storeCaptchaPoints(points) {
    sessionStorage.setItem('verifyResult', JSON.stringify(points.map(point => ({
      left: point.x,
      top: point.y
    }))));
  }

  function showRecordedCaptchaPoints(image, points) {
    const container = image.parentElement;
    if (!container) return;

    container.querySelectorAll('.yidun_icon-point').forEach(marker => marker.remove());
    points.forEach((point, index) => {
      const marker = document.createElement('div');
      marker.className = `yidun_icon-point yidun_point-${index + 1}`;
      marker.style.marginLeft = `${point.x - 13}px`;
      marker.style.marginTop = `${point.y - 33}px`;
      container.appendChild(marker);
    });
  }

  function pointsMatch(recorded, expected) {
    return recorded.length === expected.length && recorded.every((point, index) =>
      Math.abs(Number(point.left) - expected[index].x) <= 1 &&
      Math.abs(Number(point.top) - expected[index].y) <= 1
    );
  }

  // ---- Ask the background / offscreen worker to solve the click-captcha ----
  function solveClickCaptcha(imageBase64) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: 'solveClickCaptcha', imageData: imageBase64 },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (response && response.error) {
            reject(new Error(response.error));
            return;
          }
          resolve(response.result); // Array of { x, y } in image-coordinate space
        }
      );
    });
  }

  function prewarmClickCaptchaModels() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: 'prewarmClickCaptcha' },
        response => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (response && response.error) {
            reject(new Error(response.error));
            return;
          }
          resolve();
        }
      );
    });
  }

  // ---- Refresh the captcha by clicking the refresh icon ----
  function refreshCaptcha() {
    const refreshBtn = document.querySelector('.verify-refresh');
    if (refreshBtn) {
      refreshBtn.click();
      log('已点击刷新验证码按钮');
    } else {
      // Fallback: force a new src on the image
      const img = document.getElementById('vcodeImg');
      if (img && img.src) {
        const base = img.src.split('?')[0];
        img.src = base + '?_t=' + Date.now();
        log('已刷新验证码图片src（fallback）');
      }
    }
  }

  // ---- Wait for the captcha image to be fully loaded (src non-empty) ----
  function waitForCaptchaImage(timeout = 8000, previousSrc = null) {
    const img = document.getElementById('vcodeImg');
    if (!img) return Promise.reject(new Error('找不到 #vcodeImg'));

    return new Promise((resolve, reject) => {
      let loadedAfterStart = false;
      let settled = false;

      const observer = new MutationObserver(check);
      const timeoutId = setTimeout(() => finish(new Error('等待验证码图片超时')), timeout);

      function isReady() {
        const hasUsableImage = img.src
          && img.src !== window.location.href
          && img.complete
          && img.naturalWidth > 0;
        const isFresh = !previousSrc || img.src !== previousSrc || loadedAfterStart;
        return hasUsableImage && isFresh;
      }

      function cleanup() {
        clearTimeout(timeoutId);
        observer.disconnect();
        img.removeEventListener('load', handleLoad);
        img.removeEventListener('error', check);
      }

      function finish(error = null) {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(img);
      }

      function handleLoad() {
        loadedAfterStart = true;
        check();
      }

      function check() {
        if (isReady()) finish();
      }

      observer.observe(img, { attributes: true, attributeFilter: ['src'] });
      img.addEventListener('load', handleLoad);
      img.addEventListener('error', check);
      check();
    });
  }

  function refreshCaptchaAndWait(timeout = 8000) {
    const img = document.getElementById('vcodeImg');
    const previousSrc = img ? img.src : null;
    refreshCaptcha();
    return waitForCaptchaImage(timeout, previousSrc);
  }

  // ---- Detect whether a wrong-captcha error is visible ----
  function isCaptchaError() {
    // Common error container selectors for this page
    const selectors = [
      '.cv-error-msg',
      '.cv-tips',
      '[class*="error"]',
      '[class*="tip"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent && el.offsetParent !== null) {
        const txt = el.textContent.trim();
        if (txt.includes('验证码') || txt.includes('错误') || txt.includes('失败')) {
          return true;
        }
      }
    }
    return false;
  }

  function isInferenceEngineError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /ERROR_CODE|output tensor|non-tensor|ONNX|WASM|worker/i.test(message);
  }

  // ---- Detect whether the "select round" confirmation dialog appeared ----
  function findConfirmButton() {
    // Try exact selector first
    const byIndex = document.querySelector('button[data-index="0"].bh-btn-primary');
    if (byIndex && byIndex.offsetParent !== null) return byIndex;

    // Fallback: find visible button containing text "确认"
    const all = document.querySelectorAll('button.bh-btn-primary');
    for (const btn of all) {
      if (btn.offsetParent !== null && btn.textContent.trim().includes('确认')) {
        return btn;
      }
    }
    return null;
  }

  function waitForConfirmButton(timeout = 5000) {
    return new Promise(resolve => {
      let settled = false;
      let observer;
      let timeoutId;

      function finish(button) {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        observer.disconnect();
        resolve(button);
      }

      function check() {
        const confirmButton = findConfirmButton();
        if (confirmButton) finish(confirmButton);
        else if (isCaptchaError()) finish(null);
      }

      observer = new MutationObserver(check);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
        attributeFilter: ['class', 'style', 'disabled']
      });
      timeoutId = setTimeout(() => finish(null), timeout);
      check();
    });
  }

  function clickCourseButton(timeout = 10000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let observer;
      let timeoutId;

      function finish(error = null) {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        observer.disconnect();
        if (error) reject(error);
        else resolve();
      }

      function check() {
        const courseButton = document.getElementById('courseBtn');
        if (courseButton && !courseButton.disabled && courseButton.offsetParent !== null) {
          courseButton.click();
          log('✅ 已点击“开始选课”按钮');
          finish();
        }
      }

      observer = new MutationObserver(check);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'disabled']
      });
      timeoutId = setTimeout(() => {
        finish(new Error('确认轮次后未找到可点击的“开始选课”按钮'));
      }, timeout);
      check();
    });
  }

  async function confirmRoundAndStartCourse(confirmButton) {
    confirmButton.click();
    log('✅ 已点击确认按钮，等待“开始选课”按钮...');
    await clickCourseButton();
  }

  // ---- Main automation loop ----
  async function run() {
    if (isRunning) return;
    isRunning = true;
    log('选课页面自动化启动');

    try {
      // Fill credentials, warm models, and wait for the captcha concurrently.
      log('正在并行填充账号密码、预热模型并等待验证码...');
      const credentialsPromise = fillLoginCredentials();
      const modelWarmupPromise = prewarmClickCaptchaModels();
      const captchaPromise = waitForCaptchaImage(15000);
      const [credentials] = await Promise.all([
        credentialsPromise,
        modelWarmupPromise,
        captchaPromise
      ]);
      log('验证码图片和识别模型已就绪');

      while (retryCount < MAX_RETRIES) {
        retryCount++;
        log(`尝试第 ${retryCount} 次...`);

        try {
          // 2. Grab the captcha image
          const imgEl = document.getElementById('vcodeImg');
          if (!imgEl) throw new Error('找不到 #vcodeImg');

          const imageBase64 = await getCaptchaImageBase64();
          log('已获取验证码图片数据');

          // 3. Call offscreen to solve the click-captcha
          log('正在识别验证码...');
          const coords = await solveClickCaptcha(imageBase64);
          log(`识别成功，点击坐标: ${JSON.stringify(coords)}`);
          if (!Array.isArray(coords) || coords.length !== 4) {
            throw new Error(`验证码识别结果无效: ${JSON.stringify(coords)}`);
          }

          // 4. Click each coordinate in order on the captcha image
          const displayedPoints = [];
          for (let i = 0; i < coords.length; i++) {
            const { x, y } = coords[i];
            const adjustedY = Math.max(0, y + CAPTCHA_CLICK_Y_OFFSET);
            const displayedPoint = simulateClick(imgEl, x, adjustedY);
            displayedPoints.push(displayedPoint);
            log(`点击第 ${i + 1} 个字符: 原图(${x}, ${adjustedY})，页面(${displayedPoint.x}, ${displayedPoint.y})`);
            if (i < coords.length - 1) await delay(10);
          }

          // The site submits sessionStorage.verifyResult.  Normally the native
          // click handler above fills it; record it explicitly if an isolated
          // content-script event was not observed by that handler.
          const recordedPoints = getRecordedCaptchaPoints();
          if (!pointsMatch(recordedPoints, displayedPoints)) {
            log(`页面未登记合成点击（当前 ${recordedPoints.length}/4），回退写入验证码坐标`, 'warn');
            storeCaptchaPoints(displayedPoints);
            showRecordedCaptchaPoints(imgEl, displayedPoints);
          }
          if (getRecordedCaptchaPoints().length !== 4) {
            throw new Error('页面未能保存四个验证码点击坐标');
          }

          log('验证码点击完成，准备登录...');

          // 5. Click the login button
          const loginBtn = document.getElementById('studentLoginBtn');
          if (!loginBtn) throw new Error('找不到登录按钮 #studentLoginBtn');
          const loginNameInput = document.getElementById('loginName');
          const loginPwdInput = document.getElementById('loginPwd');
          if (loginNameInput.value !== credentials.username) {
            setInputValue(loginNameInput, credentials.username);
          }
          if (loginPwdInput.value !== credentials.password) {
            setInputValue(loginPwdInput, credentials.password);
          }
          loginBtn.click();
          log('已点击登录按钮，等待响应...');

          // 6. Poll rapidly and continue as soon as confirmation appears.
          const confirmBtn = await waitForConfirmButton(5000);
          if (confirmBtn) {
            log('✅ 登录成功！检测到选轮次弹窗，点击确认...');
            await confirmRoundAndStartCourse(confirmBtn);
            isRunning = false;
            return;
          }

          // Check if captcha was wrong
          if (isCaptchaError()) {
            log('❌ 验证码错误，刷新后重试...', 'warn');
            await refreshCaptchaAndWait(8000);
            continue;
          }

          // Allow a little more time for a slow server response.
          const confirmBtn2 = await waitForConfirmButton(2500);
          if (confirmBtn2) {
            log('✅ 延迟检测到选轮次弹窗，点击确认...');
            await confirmRoundAndStartCourse(confirmBtn2);
            isRunning = false;
            return;
          }

          // Still nothing – assume wrong captcha, refresh and retry
          log('⚠️ 未检测到明确结果，刷新验证码重试...', 'warn');
          await refreshCaptchaAndWait(8000);

        } catch (err) {
          if (isInferenceEngineError(err)) {
            log(`验证码识别引擎错误，停止自动化: ${err.message}`, 'error');
            return;
          }
          log(`本次尝试失败: ${err.message}，刷新验证码重试...`, 'warn');
          try {
            await refreshCaptchaAndWait(8000);
          } catch (_) {
            log('等待验证码超时，继续...', 'warn');
          }
        }
      }

      log(`已达最大重试次数 (${MAX_RETRIES})，停止自动化`, 'error');
    } catch (err) {
      log(`自动化流程出错: ${err.message}`, 'error');
    } finally {
      isRunning = false;
    }
  }

  // ---- Entry point: only run when front-page automation is enabled ----
  chrome.storage.local.get(['nju_course_auto_login', 'nju_page_auto_login']).then(data => {
    const courseAutoLoginEnabled = data.nju_course_auto_login ?? data.nju_page_auto_login === true;
    if (!courseAutoLoginEnabled) return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run);
    } else {
      run();
    }
  });

})();
