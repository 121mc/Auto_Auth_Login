// ============================================
// NJU Auto Auth Login - Background Service Worker
// ============================================

const ALARM_NAME = 'nju_auth_check';
const LOGIN_URL = 'https://authserver.nju.edu.cn/authserver/login';
const REDIRECT_URL = 'https://authserver.nju.edu.cn/personalInfo/personCenter/index.html';

// --- Logging Helper ---
async function addLog(msg, level = 'info') {
  const data = await chrome.storage.local.get('nju_logs');
  const logs = data.nju_logs || [];
  logs.push({ time: Date.now(), msg, level });
  if (logs.length > 100) logs.splice(0, logs.length - 100);
  await chrome.storage.local.set({ nju_logs: logs });
  console.log(`[NJU Auth][${level}] ${msg}`);
}

// --- Random interval: 3~5 minutes (180~300 seconds) ---
function getRandomIntervalMinutes() {
  // 3 to 5 minutes, uniform distribution
  return 3 + Math.random() * 2;
}

// --- Schedule next alarm ---
async function scheduleNextAlarm() {
  const data = await chrome.storage.local.get('nju_enabled');
  if (!data.nju_enabled) {
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.storage.local.set({ nju_next_check: null });
    return;
  }

  const delayMinutes = getRandomIntervalMinutes();
  const nextTime = Date.now() + delayMinutes * 60 * 1000;

  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, { delayInMinutes: delayMinutes });
  await chrome.storage.local.set({ nju_next_check: nextTime });

  await addLog(`下次检查将在 ${delayMinutes.toFixed(1)} 分钟后`);
}

// --- Check login status ---
async function checkLoginStatus(isManual = false) {
  const data = await chrome.storage.local.get(['nju_username', 'nju_password', 'nju_enabled']);

  if (!isManual && !data.nju_enabled) {
    await chrome.storage.local.set({ nju_status: 'disabled' });
    return;
  }

  if (!data.nju_username || !data.nju_password) {
    await addLog('未配置用户名或密码，跳过检查', 'warn');
    await chrome.storage.local.set({ nju_status: data.nju_enabled ? 'idle' : 'disabled' });
    return;
  }

  await chrome.storage.local.set({
    nju_status: 'checking',
    nju_last_check: Date.now()
  });
  await addLog('正在检查登录状态...');

  try {
    // Use fetch with redirect: 'manual' to detect redirects
    const response = await fetch(LOGIN_URL, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'include'
    });

    // response.type === 'opaqueredirect' means we got a redirect (still logged in)
    if (response.type === 'opaqueredirect' || response.status === 302 || response.status === 301) {
      await chrome.storage.local.set({ nju_status: 'active' });
      await addLog('✅ 登录有效，无需重新登录', 'success');
      await scheduleNextAlarm();
      return;
    }

    // If we get a 200, check if it's the login page
    if (response.status === 200) {
      const text = await response.text();
      if (text.includes('统一身份认证') || text.includes('pwdFromId') || text.includes('authserver/login')) {
        // Login page returned - session expired
        await addLog('⚠️ 登录已过期，准备自动登录...', 'warn');
        await chrome.storage.local.set({ nju_status: 'logging_in' });
        await performLogin();
      } else {
        // Some other page, might still be logged in
        await chrome.storage.local.set({ nju_status: 'active' });
        await addLog('✅ 登录有效', 'success');
      }
    } else {
      await addLog(`检查返回异常状态码: ${response.status}`, 'error');
      await chrome.storage.local.set({ nju_status: 'error' });
    }
  } catch (err) {
    await addLog(`检查登录状态失败: ${err.message}`, 'error');
    await chrome.storage.local.set({ nju_status: 'error' });
  }

  await scheduleNextAlarm();
}

// --- Perform login by opening a tab ---
async function performLogin() {
  try {
    // Set a flag so content script knows to auto-login
    await chrome.storage.local.set({ nju_auto_login_pending: true });

    // Create a new tab with the login page
    const tab = await chrome.tabs.create({
      url: LOGIN_URL,
      active: false  // Open in background
    });

    await addLog(`已打开登录页面 (标签页 #${tab.id})`);

    // The content script will handle the rest
    // Set a timeout to close the tab if login doesn't complete
    setTimeout(async () => {
      try {
        const pending = await chrome.storage.local.get('nju_auto_login_pending');
        if (pending.nju_auto_login_pending) {
          // Login didn't complete in time
          await addLog('登录超时，关闭标签页', 'error');
          await chrome.storage.local.set({
            nju_auto_login_pending: false,
            nju_status: 'error'
          });
          try {
            await chrome.tabs.remove(tab.id);
          } catch (e) {
            // Tab might already be closed
          }
        }
      } catch (e) {
        // Ignore
      }
    }, 60000); // 60 second timeout

  } catch (err) {
    await addLog(`打开登录页面失败: ${err.message}`, 'error');
    await chrome.storage.local.set({ nju_status: 'error' });
  }
}

// --- Offscreen document management ---
let creatingOffscreen = null;

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('offscreen/offscreen.html')]
  });

  if (existingContexts.length > 0) {
    return;
  }

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['WORKERS'],
    justification: 'Run ONNX Runtime Web for captcha recognition'
  });

  await creatingOffscreen;
  creatingOffscreen = null;
}

// --- Message handler ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'updateSettings') {
    handleUpdateSettings(message.enabled);
    sendResponse({ ok: true });
    return false;
  }

  if (message.action === 'checkNow') {
    checkLoginStatus(true);
    sendResponse({ ok: true });
    return false;
  }

  if (message.action === 'solveCaptcha') {
    // Forward to offscreen document
    handleSolveCaptcha(message.imageData)
      .then(result => sendResponse({ result }))
      .catch(err => sendResponse({ error: err.message }));
    return true; // Keep message channel open for async response
  }

  if (message.action === 'loginComplete') {
    const tabId = sender.tab ? sender.tab.id : message.tabId;
    handleLoginComplete(message.success, tabId, message.message, message.userInitiated);
    sendResponse({ ok: true });
    return false;
  }

  if (message.action === 'contentLog') {
    addLog(message.msg, message.level || 'info');
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function handleUpdateSettings(enabled) {
  if (enabled) {
    await scheduleNextAlarm();
    await addLog('自动登录已启用');
  } else {
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.storage.local.set({
      nju_status: 'disabled',
      nju_next_check: null
    });
    await addLog('自动登录已禁用');
  }
}

async function handleSolveCaptcha(imageData) {
  await ensureOffscreenDocument();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('验证码识别超时'));
    }, 30000);

    chrome.runtime.sendMessage(
      { action: 'offscreen_solveCaptcha', imageData },
      (response) => {
        clearTimeout(timeout);
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
}

async function handleLoginComplete(success, tabId, message, userInitiated = false) {
  await chrome.storage.local.set({ nju_auto_login_pending: false });

  if (success) {
    const data = await chrome.storage.local.get('nju_login_count');
    const count = (data.nju_login_count || 0) + 1;
    await chrome.storage.local.set({
      nju_status: 'active',
      nju_login_count: count
    });
    const triggerSource = userInitiated ? '页面触发' : '定时触发';
    await addLog(`✅ 自动登录成功！(第 ${count} 次, ${triggerSource})`, 'success');
  } else {
    await chrome.storage.local.set({ nju_status: 'error' });
    await addLog(`❌ 自动登录失败: ${message || '未知错误'}`, 'error');
  }

  // Only close the tab for extension-triggered logins (not user-initiated)
  if (tabId && !userInitiated) {
    setTimeout(async () => {
      try {
        await chrome.tabs.remove(tabId);
      } catch (e) {
        // Tab might already be closed
      }
    }, 3000);
  }

  await scheduleNextAlarm();
}

// --- Alarm listener ---
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await checkLoginStatus();
  }
});

// --- Extension install/startup ---
chrome.runtime.onInstalled.addListener(async () => {
  await addLog('扩展已安装/更新');
  const data = await chrome.storage.local.get('nju_enabled');
  if (data.nju_enabled) {
    await scheduleNextAlarm();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const data = await chrome.storage.local.get('nju_enabled');
  if (data.nju_enabled) {
    await addLog('浏览器启动，恢复自动检查');
    await scheduleNextAlarm();
  }
});
