// ============================================
// NJU Auto Auth Login - Content Script
// Injected into authserver.nju.edu.cn/authserver/login
// ============================================

(async function () {
  'use strict';

  // --- Helpers ---
  function log(msg, level = 'info') {
    console.log(`[NJU Auto Auth][${level}] ${msg}`);
    chrome.runtime.sendMessage({ action: 'contentLog', msg, level }).catch(() => {});
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function refreshCaptcha(loginViewDiv, captchaImg = null, timeoutMs = 2000) {
    const image = captchaImg || loginViewDiv.querySelector('#captchaImg') ||
                  document.querySelector('.login-main #captchaImg');
    if (!image) return false;

    const previousSrc = image.src;
    const refreshBtn = loginViewDiv.querySelector('.captcha-refresh');
    if (refreshBtn) {
      refreshBtn.click();
    } else {
      image.src = '/authserver/getCaptcha.htl?' + Date.now();
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hasNewImage = image.src && image.src.includes('getCaptcha') &&
                          image.src !== previousSrc && image.complete &&
                          image.naturalWidth > 0;
      if (hasNewImage) return true;
      await sleep(50);
    }
    return false;
  }

  function getLoginErrorText() {
    const errorTip = document.querySelector('.login-main #showErrorTip');
    return errorTip ? errorTip.textContent.trim() : '';
  }

  async function waitForLoginOutcome(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!window.location.href.includes('authserver/login')) {
        return { success: true };
      }
      const errorText = getLoginErrorText();
      if (errorText) return { errorText };
      await sleep(100);
    }
    return { timedOut: true };
  }

  function isElementVisible(element) {
    if (!element || !element.isConnected) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' &&
           Number(style.opacity || 1) !== 0 && element.getClientRects().length > 0;
  }
  function getVisibleImageCaptcha(loginViewDiv) {
    const captchaDiv = loginViewDiv.querySelector('#captchaDiv');
    const captchaInput = loginViewDiv.querySelector('.m-account #captcha') ||
                         loginViewDiv.querySelector('#captcha');
    const captchaImg = loginViewDiv.querySelector('#captchaImg');
    return isElementVisible(captchaDiv) && isElementVisible(captchaInput) &&
           isElementVisible(captchaImg) ? { captchaDiv, captchaInput, captchaImg } : null;
  }

  async function waitForVisibleImageCaptcha(loginViewDiv, timeoutMs = 1500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const captcha = getVisibleImageCaptcha(loginViewDiv);
      if (captcha) return captcha;
      await sleep(100);
    }
    return getVisibleImageCaptcha(loginViewDiv);
  }

  function getSliderElements() {
    const root = document.querySelector('#sliderCaptchaDiv');
    if (!root || !isElementVisible(root)) return null;

    const slider = root.querySelector('.slider');
    const sliderContainer = root.querySelector('.sliderContainer');
    const blockCanvas = root.querySelector('canvas.block');
    const backgroundCanvas = root.querySelector('#sliderDiv > canvas:not(.block)') ||
                             root.querySelector('canvas:not(.block)');
    if (!slider || !sliderContainer || !blockCanvas || !backgroundCanvas) return null;
    return { root, slider, sliderContainer, blockCanvas, backgroundCanvas };
  }

  async function waitForSliderElements(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const elements = getSliderElements();
      if (elements && elements.blockCanvas.width > 0 && elements.blockCanvas.height > 0) {
        try {
          const pixels = elements.blockCanvas.getContext('2d').getImageData(
            0, 0, elements.blockCanvas.width, elements.blockCanvas.height
          ).data;
          for (let i = 3; i < pixels.length; i += 4) {
            if (pixels[i] > 32) return elements;
          }
        } catch (e) {
          // The canvas may still be initializing; retry until the timeout.
        }
      }
      await sleep(100);
    }
    return null;
  }
  function findSliderTarget(elements) {
    const { root, blockCanvas, backgroundCanvas } = elements;
    const sourceImage = root.querySelector('#slider-img1');
    if (!sourceImage || !sourceImage.complete || !sourceImage.naturalWidth) {
      throw new Error('Slider source image is not loaded');
    }

    const width = backgroundCanvas.width;
    const height = backgroundCanvas.height;
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = width;
    sourceCanvas.height = height;
    const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
    sourceContext.drawImage(sourceImage, 0, 0, width, height);

    const source = sourceContext.getImageData(0, 0, width, height).data;
    const blockContext = blockCanvas.getContext('2d', { willReadFrequently: true });
    const blockWidth = blockCanvas.width;
    const blockHeight = blockCanvas.height;
    const block = blockContext.getImageData(0, 0, blockWidth, blockHeight).data;
    const samplePixels = [];

    // Ignore the translucent puzzle border. Interior opaque pixels preserve the
    // original image and provide a much more reliable template match.
    for (let y = 1; y < Math.min(height, blockHeight) - 1; y += 2) {
      for (let x = 1; x < blockWidth - 1; x += 2) {
        const index = (y * blockWidth + x) * 4;
        if (block[index + 3] < 245) continue;
        const leftAlpha = block[index - 1];
        const rightAlpha = block[index + 7];
        const upperAlpha = block[index - blockWidth * 4 + 3];
        const lowerAlpha = block[index + blockWidth * 4 + 3];
        if (leftAlpha < 220 || rightAlpha < 220 || upperAlpha < 220 || lowerAlpha < 220) continue;
        samplePixels.push({ x, y, r: block[index], g: block[index + 1], b: block[index + 2] });
      }
    }

    if (samplePixels.length < 20) {
      throw new Error('Unable to read slider puzzle pixels');
    }

    const maxBlockX = samplePixels.reduce((max, pixel) => Math.max(max, pixel.x), 0);
    let bestLeft = -1;
    let bestScore = Infinity;
    for (let left = 0; left + maxBlockX < width; left++) {
      let score = 0;
      for (const pixel of samplePixels) {
        const sourceIndex = (pixel.y * width + left + pixel.x) * 4;
        score += Math.abs(pixel.r - source[sourceIndex]) +
                 Math.abs(pixel.g - source[sourceIndex + 1]) +
                 Math.abs(pixel.b - source[sourceIndex + 2]);
        if (score >= bestScore) break;
      }
      if (score < bestScore) {
        bestScore = score;
        bestLeft = left;
      }
    }

    if (bestLeft < 0) throw new Error('Unable to locate the slider target');
    return bestLeft;
  }
  async function dragSlider(elements, targetLeft, attempt) {
    const { slider, sliderContainer, backgroundCanvas } = elements;
    const sliderRect = slider.getBoundingClientRect();
    const containerWidth = sliderContainer.getBoundingClientRect().width || backgroundCanvas.width + 2;
    const sliderWidth = sliderRect.width || 40;
    const sliderTravel = containerWidth - sliderWidth;
    // NJU's customized Longbow 2.0 moves the handle and puzzle block 1:1.
    const correction = [-1, 0, 1, -2, 2][(attempt - 1) % 5];
    const dragDistance = Math.max(2, Math.min(
      sliderTravel - 1,
      targetLeft + correction
    ));
    const startX = sliderRect.left + sliderWidth / 2;
    const startY = sliderRect.top + (sliderRect.height || 40) / 2;

    slider.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, clientX: startX, clientY: startY, buttons: 1
    }));

    const steps = 30 + attempt * 2;
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const eased = 1 - Math.pow(1 - t, 3);
      const jitter = Math.sin(step * 1.7) * 1.4 + Math.sin(step * 0.43) * 0.8;
      document.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX: startX + dragDistance * eased,
        clientY: startY + jitter,
        buttons: 1
      }));
      await sleep(10 + (step % 4) * 3);
    }

    document.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true,
      cancelable: true,
      clientX: startX + dragDistance,
      clientY: startY + Math.sin(steps * 1.7) * 1.4,
      buttons: 0
    }));
  }

  async function solveSliderCaptcha(maxAttempts = 5) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      log(`Starting slider attempt ${attempt}...`);
      const elements = await waitForSliderElements(5000);
      if (!elements) throw new Error('Timed out while loading slider captcha');

      const targetLeft = findSliderTarget(elements);
      log(`Slider target located at ${targetLeft}px`);
      await dragSlider(elements, targetLeft, attempt);

      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        if (!window.location.href.includes('authserver/login')) return true;
        if (elements.sliderContainer.classList.contains('sliderContainer_success')) {
          log('Slider verified; waiting for login submission...');
          const outcome = await waitForLoginOutcome(6000);
          if (outcome.success) return true;
          if (outcome.errorText) throw new Error(`Login failed: ${outcome.errorText}`);
          // Some versions remove the captcha before submitting the form.
          if (!document.querySelector('#sliderCaptchaDiv .sliderContainer')) return true;
          break;
        }
        if (elements.sliderContainer.classList.contains('sliderContainer_fail')) break;
        const errorText = getLoginErrorText();
        if (errorText) throw new Error(`Login failed: ${errorText}`);
        await sleep(100);
      }

      if (attempt < maxAttempts) {
        log('Slider verification failed; waiting for refresh...', 'warn');
        await sleep(1200);
      }
    }
    throw new Error('Slider verification failed after multiple attempts');
  }

  async function submitWithoutImageCaptcha(loginViewDiv) {
    const loginBtn = loginViewDiv.querySelector('#login_submit');
    if (!loginBtn) throw new Error('Login button not found');

    log('No image captcha is visible; submitting login directly...');
    loginBtn.click();

    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if (!window.location.href.includes('authserver/login')) return true;
      if (getSliderElements()) {
        log('Slider captcha appeared after submit; solving...');
        return solveSliderCaptcha();
      }
      const errorText = getLoginErrorText();
      if (errorText) throw new Error(`Login failed: ${errorText}`);
      await sleep(100);
    }
    throw new Error('Login did not respond after submission');
  }

  function waitForElement(selector, container, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const el = container.querySelector(selector);
      if (el) {
        resolve(el);
        return;
      }

      const observer = new MutationObserver(() => {
        const el = container.querySelector(selector);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });

      observer.observe(container, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        const el = container.querySelector(selector);
        if (el) {
          resolve(el);
        } else {
          reject(new Error(`等待元素 ${selector} 超时`));
        }
      }, timeoutMs);
    });
  }

  // --- Check if we should auto-login ---
  const data = await chrome.storage.local.get([
    'nju_auto_login_pending', 'nju_username', 'nju_password',
    'nju_auth_auto_login', 'nju_page_auto_login'
  ]);

  const isPending = data.nju_auto_login_pending;
  const authAutoLoginEnabled = data.nju_auth_auto_login ?? data.nju_page_auto_login === true;
  const isPageLogin = !isPending && authAutoLoginEnabled;

  if (!isPending && !isPageLogin) {
    // Not triggered by our extension and auto-login not enabled, do nothing
    return;
  }

  const username = data.nju_username;
  const password = data.nju_password;

  if (!username || !password) {
    if (isPending) {
      log('用户名或密码未配置', 'error');
      notifyLoginResult(false, '用户名或密码未配置');
    }
    // If it's a page-visit trigger, silently skip — user hasn't configured credentials
    return;
  }

  if (isPageLogin) {
    log('检测到用户打开了登录页面，自动登录已启用，开始自动填充...');
  } else {
    log('内容脚本已注入，开始自动登录流程...');
  }

  try {
    await performAutoLogin(username, password);
  } catch (err) {
    log(`自动登录异常: ${err.message}`, 'error');
    if (isPending) {
      notifyLoginResult(false, err.message);
    }
  }

  // =============================================
  // Main auto-login logic
  // =============================================
  async function performAutoLogin(username, password) {
    // Step 1: Wait for the login container to exist
    log('等待登录容器加载...');
    const loginViewDiv = await waitForElement('#loginViewDiv', document.body, 10000);

    // Check if password login is already active
    let usernameField = loginViewDiv.querySelector('.m-account #username');
    if (!usernameField) {
      // Need to switch to password login tab
      log('切换到账号登录标签...');
      const pwdLoginLink = await waitForElement('#userNameLogin_a', document.body, 5000).catch(() => null);
      if (pwdLoginLink) {
        pwdLoginLink.click();
        // Wait for the form to appear inside loginViewDiv
        try {
          usernameField = await waitForElement('#username', loginViewDiv, 3000);
        } catch(e) {}
      }

      if (!usernameField) {
        usernameField = loginViewDiv.querySelector('.m-account #username') || loginViewDiv.querySelector('#username');
      }
      if (!usernameField) {
        throw new Error('找不到用户名输入框');
      }
    }

    // Step 3: Fill username
    log('填写用户名...');
    usernameField.removeAttribute('readonly');
    setNativeValue(usernameField, username);
    usernameField.dispatchEvent(new Event('input', { bubbles: true }));
    usernameField.dispatchEvent(new Event('change', { bubbles: true }));
    usernameField.dispatchEvent(new Event('focusout', { bubbles: true }));
    usernameField.dispatchEvent(new Event('blur', { bubbles: true }));
    await sleep(100);

    // Step 4: Fill password
    log('填写密码...');
    const passwordField = loginViewDiv.querySelector('.m-account #password') ||
                          loginViewDiv.querySelector('#password');
    if (!passwordField) {
      throw new Error('找不到密码输入框');
    }
    passwordField.removeAttribute('readonly');
    setNativeValue(passwordField, password);
    passwordField.dispatchEvent(new Event('input', { bubbles: true }));
    passwordField.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(100);

    // Step 5: Wait for captcha to load and solve it in a loop
    // The page calls checkNeedCaptcha() on username blur
    // For NJU, _badCredentialsCount == 0 means captcha is always shown
    log('等待验证码加载...');
    // Removed static sleep to ensure instant filling upon page load
    const visibleImageCaptcha = await waitForVisibleImageCaptcha(loginViewDiv);
    if (!visibleImageCaptcha) {
      await submitWithoutImageCaptcha(loginViewDiv);
      log('Login completed without an image captcha.', 'success');
      notifyLoginResult(true, '', isPageLogin);
      return;
    }

    log('Image captcha is visible; starting recognition...');


    let isLoginComplete = false;
    let attempt = 0;
    const maxAttempts = 20;

    while (!isLoginComplete && attempt < maxAttempts) {
      attempt++;
      if (attempt > 1) {
        log(`开始第 ${attempt} 次尝试识别验证码...`);
      }

      // Check if we are still on the login page
      if (!window.location.href.includes('authserver/login')) {
        isLoginComplete = true;
        break;
      }

      // Force show captcha if not visible
      const captchaDiv = loginViewDiv.querySelector('#captchaDiv');
      if (captchaDiv && captchaDiv.classList.contains('hide')) {
        log('强制显示验证码区域...');
        await refreshCaptcha(loginViewDiv);
      }

      // Step 6: Get captcha image
      const captchaImg = loginViewDiv.querySelector('#captchaImg') ||
                         document.querySelector('.login-main #captchaImg');
      if (!captchaImg) {
        throw new Error('找不到验证码图片元素');
      }

      // Wait for image to have a valid src
      let retries = 0;
      while ((!captchaImg.src || !captchaImg.src.includes('getCaptcha')) && retries < 25) {
        await sleep(200);
        retries++;
      }

      if (!captchaImg.src || !captchaImg.src.includes('getCaptcha')) {
        // Manually trigger captcha load and continue as soon as the image updates.
        log('手动触发验证码加载...');
        await refreshCaptcha(loginViewDiv, captchaImg);
      }

      log(`验证码图片URL: ${captchaImg.src}`);

      // Step 7: Fetch captcha image data
      let captchaImageData;
      try {
        const captchaResponse = await fetch(captchaImg.src, { credentials: 'include' });
        const captchaBlob = await captchaResponse.blob();
        captchaImageData = await blobToBase64(captchaBlob);
      } catch (e) {
        // Fallback: draw to canvas
        log('通过 canvas 获取验证码图片...');
        captchaImageData = await getImageFromCanvas(captchaImg);
      }

      if (!captchaImageData) {
        throw new Error('无法获取验证码图片数据');
      }

      // Step 8: Send to background for ONNX recognition
      log('正在识别验证码...');
      let captchaResult = '';
      try {
        captchaResult = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(
            {
              action: 'solveCaptcha',
              imageData: captchaImageData,
              debugContext: {
                attempt,
                pageUrl: window.location.href,
                imageUrl: captchaImg.currentSrc || captchaImg.src
              }
            },
            (response) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
              }
              if (response && response.error) {
                reject(new Error(response.error));
                return;
              }
              resolve(response.result);
            }
          );
        });
      } catch (err) {
        log(`验证码识别请求失败: ${err.message}`, 'error');
      }

      if (!captchaResult || captchaResult.length === 0) {
        log('验证码识别结果为空，准备重试...', 'warn');
        await refreshCaptcha(loginViewDiv, captchaImg);
        continue;
      }

      log(`验证码识别结果: ${captchaResult}`);

      // Step 9: Fill captcha
      const captchaInput = loginViewDiv.querySelector('.m-account #captcha') ||
                           loginViewDiv.querySelector('#captcha');
      if (!captchaInput) {
        throw new Error('找不到验证码输入框');
      }
      setNativeValue(captchaInput, captchaResult);
      captchaInput.dispatchEvent(new Event('input', { bubbles: true }));
      captchaInput.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(50);

      // Restore password if it was disabled in previous attempt
      const passwordField = loginViewDiv.querySelector('.m-account #password') ||
                            loginViewDiv.querySelector('#password');
      if (passwordField && passwordField.hasAttribute('disabled')) {
        passwordField.removeAttribute('disabled');
        setNativeValue(passwordField, password);
        passwordField.dispatchEvent(new Event('input', { bubbles: true }));
        passwordField.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // Step 10: Submit the form via page's own functions
      log('提交登录表单...');

      const loginBtn = loginViewDiv.querySelector('#login_submit');
      if (loginBtn) {
        loginBtn.click();
      } else {
        throw new Error('找不到登录按钮');
      }

      // Step 11: Continue as soon as the page redirects or reports an error.
      log('等待登录结果...');
      const outcome = await waitForLoginOutcome();

      if (outcome.success) {
        isLoginComplete = true;
        break;
      }

      if (outcome.errorText) {
        if (outcome.errorText.includes('验证码')) {
          log(`提示: ${outcome.errorText}，立即重试...`, 'warn');
          await refreshCaptcha(loginViewDiv, captchaImg);
          if (passwordField) {
            passwordField.removeAttribute('disabled');
            setNativeValue(passwordField, password);
            passwordField.dispatchEvent(new Event('input', { bubbles: true }));
            passwordField.dispatchEvent(new Event('change', { bubbles: true }));
          }
        } else {
          throw new Error(`登录失败: ${outcome.errorText}`);
        }
      } else {
        log('长时间无响应，准备重试...');
      }
    }

    if (!isLoginComplete) {
      throw new Error('多次尝试验证码后登录仍未成功');
    }

    // Login successful (redirected away from login page)
    log('登录成功！', 'success');
    notifyLoginResult(true, '', isPageLogin);
  }

  // =============================================
  // Utility functions
  // =============================================

  function setNativeValue(element, value) {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    nativeInputValueSetter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function getImageFromCanvas(imgElement) {
    return new Promise((resolve, reject) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        // Ensure we capture at the exact intrinsic resolution, handling 80x30 properly
        const w = img.naturalWidth || img.width || 80;
        const h = img.naturalHeight || img.height || 30;
        canvas.width = w;
        canvas.height = h;
        
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = reject;
      img.src = imgElement.src;
    });
  }

  function notifyLoginResult(success, message = '', userInitiated = false) {
    chrome.runtime.sendMessage({
      action: 'loginComplete',
      success,
      message,
      userInitiated,
      tabId: null // Background will get tabId from sender
    }).catch(() => {});
  }

  // --- Monitor page navigation for login result ---
  // If the page navigates away from login, it means success
  const originalUrl = window.location.href;
  const navigationObserver = new MutationObserver(() => {
    if (!window.location.href.includes('authserver/login') && 
        window.location.href !== originalUrl) {
      log('页面已跳转，登录成功！', 'success');
      notifyLoginResult(true, '', isPageLogin);
    }
  });

  // Also listen for beforeunload as a signal
  window.addEventListener('beforeunload', () => {
    // If we're navigating away from login page, it likely means success
    if (window.location.href !== originalUrl) {
      notifyLoginResult(true, '', isPageLogin);
    }
  });

})();
