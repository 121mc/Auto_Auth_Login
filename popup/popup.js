// ============================================
// NJU Auto Auth Login - Popup Script
// ============================================

document.addEventListener('DOMContentLoaded', async () => {
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');
  const authAutoLoginToggle = document.getElementById('authAutoLoginToggle');
  const periodicCheckToggle = document.getElementById('periodicCheckToggle');
  const periodicCheckRow = document.getElementById('periodicCheckRow');
  const courseAutoLoginToggle = document.getElementById('courseAutoLoginToggle');
  const saveBtn = document.getElementById('saveBtn');
  const togglePasswordBtn = document.getElementById('togglePassword');
  const clearLogBtn = document.getElementById('clearLogBtn');
  const logArea = document.getElementById('logArea');
  const statusCard = document.getElementById('statusCard');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const lastCheckTime = document.getElementById('lastCheckTime');
  const nextCheckTime = document.getElementById('nextCheckTime');
  const loginCount = document.getElementById('loginCount');

  // ----- Load saved settings -----
  const data = await chrome.storage.local.get([
    'nju_username', 'nju_password', 'nju_enabled',
    'nju_auth_auto_login', 'nju_course_auto_login', 'nju_page_auto_login',
    'nju_last_check', 'nju_next_check', 'nju_login_count',
    'nju_status', 'nju_logs'
  ]);

  if (data.nju_username) usernameInput.value = data.nju_username;
  if (data.nju_password) passwordInput.value = data.nju_password;

  // Keep existing installations working until each new toggle is changed once.
  const legacyPageAutomation = data.nju_page_auto_login === true;
  authAutoLoginToggle.checked = data.nju_auth_auto_login ?? legacyPageAutomation;
  periodicCheckToggle.checked = authAutoLoginToggle.checked && data.nju_enabled === true;
  courseAutoLoginToggle.checked = data.nju_course_auto_login ?? legacyPageAutomation;
  updatePeriodicCheckAvailability();
  loginCount.textContent = data.nju_login_count || 0;

  updateStatus(data.nju_status || 'idle');
  updateTimeDisplay(lastCheckTime, data.nju_last_check);
  updateNextCheckDisplay(data.nju_next_check);
  renderLogs(data.nju_logs || []);

  // ----- Toggle password visibility -----
  togglePasswordBtn.addEventListener('click', () => {
    const isPassword = passwordInput.type === 'password';
    passwordInput.type = isPassword ? 'text' : 'password';
    togglePasswordBtn.querySelector('.eye-open').style.display = isPassword ? 'none' : 'block';
    togglePasswordBtn.querySelector('.eye-closed').style.display = isPassword ? 'block' : 'none';
  });

  // ----- Save credentials -----
  saveBtn.addEventListener('click', async () => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    if (!username || !password) {
      showToast('请填写学号和密码', 'error');
      return;
    }

    await chrome.storage.local.set({
      nju_username: username,
      nju_password: password,
    });
    showToast('学号和密码已保存', 'success');
    addLog('学号和密码已保存');
  });

  // ----- Toggle settings save immediately -----
  authAutoLoginToggle.addEventListener('change', async () => {
    const enabled = authAutoLoginToggle.checked;
    await chrome.storage.local.set({ nju_auth_auto_login: enabled });

    if (!enabled) {
      periodicCheckToggle.checked = false;
      await chrome.storage.local.set({ nju_enabled: false });
      chrome.runtime.sendMessage({ action: 'updateSettings', enabled: false });
    }
    updatePeriodicCheckAvailability();
    showToast(enabled ? '统一身份认证自动登录已开启' : '统一身份认证自动登录已关闭', 'success');
  });

  periodicCheckToggle.addEventListener('change', async () => {
    if (!authAutoLoginToggle.checked) {
      periodicCheckToggle.checked = false;
      return;
    }

    const enabled = periodicCheckToggle.checked;
    await chrome.storage.local.set({ nju_enabled: enabled });
    chrome.runtime.sendMessage({ action: 'updateSettings', enabled });
    showToast(enabled ? '定时检查已开启' : '定时检查已关闭', 'success');
  });

  courseAutoLoginToggle.addEventListener('change', async () => {
    const enabled = courseAutoLoginToggle.checked;
    await chrome.storage.local.set({ nju_course_auto_login: enabled });
    showToast(enabled ? '选课页面自动登录已开启' : '选课页面自动登录已关闭', 'success');
  });

  function updatePeriodicCheckAvailability() {
    const enabled = authAutoLoginToggle.checked;
    periodicCheckToggle.disabled = !enabled;
    periodicCheckRow.classList.toggle('is-disabled', !enabled);
  }

  // ----- Clear logs -----
  clearLogBtn.addEventListener('click', async () => {
    await chrome.storage.local.set({ nju_logs: [] });
    renderLogs([]);
  });

  // ----- Listen for status updates from background -----
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes.nju_status) {
      updateStatus(changes.nju_status.newValue);
    }
    if (changes.nju_last_check) {
      updateTimeDisplay(lastCheckTime, changes.nju_last_check.newValue);
    }
    if (changes.nju_next_check) {
      updateNextCheckDisplay(changes.nju_next_check.newValue);
    }
    if (changes.nju_login_count) {
      loginCount.textContent = changes.nju_login_count.newValue || 0;
    }
    if (changes.nju_logs) {
      renderLogs(changes.nju_logs.newValue || []);
    }
  });

  // ----- Helper Functions -----

  function updateStatus(status) {
    statusCard.className = 'status-card';
    switch (status) {
      case 'active':
        statusCard.classList.add('active');
        statusText.textContent = '登录有效';
        break;
      case 'checking':
        statusCard.classList.add('checking');
        statusText.textContent = '正在检查...';
        break;
      case 'logging_in':
        statusCard.classList.add('checking');
        statusText.textContent = '正在登录...';
        break;
      case 'error':
        statusCard.classList.add('error');
        statusText.textContent = '登录失败';
        break;
      case 'disabled':
        statusText.textContent = '已禁用';
        break;
      default:
        statusText.textContent = '未配置';
    }
  }

  function updateTimeDisplay(el, timestamp) {
    if (!timestamp) {
      el.textContent = '-';
      return;
    }
    const d = new Date(timestamp);
    el.textContent = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function updateNextCheckDisplay(timestamp) {
    if (!timestamp) {
      nextCheckTime.textContent = '-';
      return;
    }
    const d = new Date(timestamp);
    const now = Date.now();
    if (timestamp > now) {
      const diffMs = timestamp - now;
      const diffMin = Math.floor(diffMs / 60000);
      const diffSec = Math.floor((diffMs % 60000) / 1000);
      nextCheckTime.textContent = `${diffMin}分${diffSec}秒后`;
    } else {
      nextCheckTime.textContent = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
  }

  function renderLogs(logs) {
    if (!logs || logs.length === 0) {
      logArea.innerHTML = '<div class="log-empty">暂无日志</div>';
      return;
    }
    logArea.innerHTML = logs.slice(-50).map(log => {
      const levelClass = log.level === 'error' ? 'log-error' :
                         log.level === 'success' ? 'log-success' :
                         log.level === 'warn' ? 'log-warn' : '';
      const time = new Date(log.time).toLocaleTimeString('zh-CN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      return `<div class="log-entry ${levelClass}"><span class="log-time">[${time}]</span>${escapeHtml(log.msg)}</div>`;
    }).join('');
    logArea.scrollTop = logArea.scrollHeight;
  }

  async function addLog(msg, level = 'info') {
    const data = await chrome.storage.local.get('nju_logs');
    const logs = data.nju_logs || [];
    logs.push({ time: Date.now(), msg, level });
    // Keep last 100 entries
    if (logs.length > 100) logs.splice(0, logs.length - 100);
    await chrome.storage.local.set({ nju_logs: logs });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function showToast(msg, type = 'info') {
    let toast = document.querySelector('.toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.className = 'toast' + (type === 'success' ? ' toast-success' : type === 'error' ? ' toast-error' : '');

    // Trigger reflow for animation
    void toast.offsetWidth;
    toast.classList.add('show');

    setTimeout(() => {
      toast.classList.remove('show');
    }, 2000);
  }

  // Update next check time periodically
  setInterval(async () => {
    const d = await chrome.storage.local.get('nju_next_check');
    updateNextCheckDisplay(d.nju_next_check);
  }, 1000);
});
