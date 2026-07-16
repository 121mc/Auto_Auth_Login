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
    'nju_auto_login_pending', 'nju_username', 'nju_password', 'nju_page_auto_login'
  ]);

  const isPending = data.nju_auto_login_pending;
  const isPageLogin = !isPending && data.nju_page_auto_login === true;

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
    await sleep(500);

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
    await sleep(500);

    // Step 5: Wait for captcha to load and solve it in a loop
    // The page calls checkNeedCaptcha() on username blur
    // For NJU, _badCredentialsCount == 0 means captcha is always shown
    log('等待验证码加载...');
    // Removed static sleep to ensure instant filling upon page load

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
        const refreshBtn = loginViewDiv.querySelector('.captcha-refresh');
        if (refreshBtn) {
          refreshBtn.click();
        } else {
          const captchaImg = document.querySelector('#captchaImg');
          if (captchaImg) captchaImg.src = '/authserver/getCaptcha.htl?' + Date.now();
        }
        await sleep(2000);
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
        // Manually trigger captcha load
        log('手动触发验证码加载...');
        const captchaSrc = '/authserver/getCaptcha.htl?' + Date.now();
        captchaImg.src = captchaSrc;
        await sleep(2000);
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
            { action: 'solveCaptcha', imageData: captchaImageData },
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
        const refreshBtn = loginViewDiv.querySelector('.captcha-refresh');
        if (refreshBtn) {
          refreshBtn.click();
        } else {
           const captchaImg = document.querySelector('#captchaImg');
           if (captchaImg) captchaImg.src = '/authserver/getCaptcha.htl?' + Date.now();
        }
        await sleep(1500);
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
      await sleep(300);

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

      // Step 11: Wait and check result
      log('等待登录结果...');
      await sleep(2000);

      if (!window.location.href.includes('authserver/login')) {
        isLoginComplete = true;
        break;
      }

      // Check for error messages
      const errorTip = document.querySelector('.login-main #showErrorTip');
      const errorText = errorTip ? errorTip.textContent.trim() : '';

      if (errorText) {
        if (errorText.includes('验证码')) {
          log(`提示: ${errorText}，立即重试...`, 'warn');
          const refreshBtn = loginViewDiv.querySelector('.captcha-refresh');
          if (refreshBtn) {
            refreshBtn.click();
          } else {
             const captchaImg = document.querySelector('#captchaImg');
             if (captchaImg) captchaImg.src = '/authserver/getCaptcha.htl?' + Date.now();
          }
          if (passwordField) {
            passwordField.removeAttribute('disabled');
            setNativeValue(passwordField, password);
            passwordField.dispatchEvent(new Event('input', { bubbles: true }));
            passwordField.dispatchEvent(new Event('change', { bubbles: true }));
          }
          await sleep(1000);
        } else {
          throw new Error(`登录失败: ${errorText}`);
        }
      } else {
        await sleep(2000);
        if (!window.location.href.includes('authserver/login')) {
          isLoginComplete = true;
          break;
        } else {
          await sleep(2000);
          if (!window.location.href.includes('authserver/login')) {
            isLoginComplete = true;
            break;
          }
          log('长时间无响应，准备重试...');
        }
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
