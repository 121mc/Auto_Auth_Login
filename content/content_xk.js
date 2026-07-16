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
  async function waitForCaptchaImage(timeout = 8000) {
    const img = document.getElementById('vcodeImg');
    if (!img) throw new Error('找不到 #vcodeImg');

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (img.src && img.src !== window.location.href && img.complete && img.naturalWidth > 0) {
        return img;
      }
      await delay(200);
    }
    throw new Error('等待验证码图片超时');
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

  // ---- Main automation loop ----
  async function run() {
    if (isRunning) return;
    isRunning = true;
    log('选课页面自动化启动');

    try {
      // 1. Wait for the captcha image to appear
      log('等待验证码图片加载...');
      await waitForCaptchaImage(15000);
      log('验证码图片已就绪');

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
          for (let i = 0; i < coords.length; i++) {
            const { x, y } = coords[i];
            const displayedPoint = simulateClick(imgEl, x, y);
            log(`点击第 ${i + 1} 个字符: 原图(${x}, ${y})，页面(${displayedPoint.x}, ${displayedPoint.y})`);
            await delay(300 + Math.random() * 200); // small human-like delay
          }

          log('验证码点击完成，等待一下再点登录按钮...');
          await delay(600);

          // 5. Click the login button
          const loginBtn = document.getElementById('studentLoginBtn');
          if (!loginBtn) throw new Error('找不到登录按钮 #studentLoginBtn');
          loginBtn.click();
          log('已点击登录按钮，等待响应...');

          // 6. Wait and check the result (1-3 seconds)
          await delay(2000);

          // Check if the confirmation dialog appeared (login succeeded)
          const confirmBtn = findConfirmButton();
          if (confirmBtn) {
            log('✅ 登录成功！检测到选轮次弹窗，点击确认...');
            confirmBtn.click();
            log('✅ 已点击确认按钮，完成！');
            isRunning = false;
            return;
          }

          // Check if captcha was wrong
          if (isCaptchaError()) {
            log('❌ 验证码错误，刷新后重试...', 'warn');
            refreshCaptcha();
            await delay(1500); // wait for new captcha to load
            await waitForCaptchaImage(8000);
            continue;
          }

          // Neither success nor explicit failure – wait a bit more then check again
          await delay(1500);
          const confirmBtn2 = findConfirmButton();
          if (confirmBtn2) {
            log('✅ 延迟检测到选轮次弹窗，点击确认...');
            confirmBtn2.click();
            log('✅ 已点击确认按钮，完成！');
            isRunning = false;
            return;
          }

          // Still nothing – assume wrong captcha, refresh and retry
          log('⚠️ 未检测到明确结果，刷新验证码重试...', 'warn');
          refreshCaptcha();
          await delay(1500);
          await waitForCaptchaImage(8000);

        } catch (err) {
          log(`本次尝试失败: ${err.message}，刷新验证码重试...`, 'warn');
          refreshCaptcha();
          await delay(1500);
          try {
            await waitForCaptchaImage(8000);
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

  // ---- Entry point: start after page is fully interactive ----
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(run, 1500));
  } else {
    setTimeout(run, 1500);
  }

})();
