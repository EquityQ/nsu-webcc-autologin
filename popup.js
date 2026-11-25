const PORTAL_URL = 'https://cc.nsu.edu.cn/';

const els = {
  statusBadge: document.getElementById('statusBadge'),
  statusMessage: document.getElementById('statusMessage'),
  pauseBanner: document.getElementById('pauseBanner'),
  metaIp: document.getElementById('metaIp'),
  metaPackage: document.getElementById('metaPackage'),
  metaOnlineCount: document.getElementById('metaOnlineCount'),
  metaTime: document.getElementById('metaTime'),
  onlineDevicesBox: document.getElementById('onlineDevicesBox'),
  btnRunNow: document.getElementById('btnRunNow'),
  btnRefresh: document.getElementById('btnRefresh'),
  btnOffline: document.getElementById('btnOffline'),
  btnOpenPortal: document.getElementById('btnOpenPortal'),
  settingsForm: document.getElementById('settingsForm'),
  enabled: document.getElementById('enabled'),
  accountType: document.getElementById('accountType'),
  username: document.getElementById('username'),
  password: document.getElementById('password'),
  btnTogglePwd: document.getElementById('btnTogglePwd'),
  preferredPackage: document.getElementById('preferredPackage'),
  packageChips: document.getElementById('packageChips'),
  autoKickOtherDevice: document.getElementById('autoKickOtherDevice'),
  checkIntervalMinutes: document.getElementById('checkIntervalMinutes'),
  showNotifications: document.getElementById('showNotifications'),
  btnSave: document.getElementById('btnSave'),
  saveTip: document.getElementById('saveTip'),
  logsList: document.getElementById('logsList'),
  btnClearLogs: document.getElementById('btnClearLogs'),
};

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { ok: false, error: '无响应' });
      }
    });
  });
}

function formatTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function getBadgeStyle(status) {
  switch (status) {
    case 'already_online':
    case 'online_success':
      return { text: '已在线', cls: 'badge badge-ok' };
    case 'device_limit':
      return { text: '设备已满', cls: 'badge badge-warn' };
    case 'need_manual_verify':
      return { text: '需手动验证', cls: 'badge badge-warn' };
    case 'auth_failed':
      return { text: '认证失败', cls: 'badge badge-err' };
    case 'error':
      return { text: '异常', cls: 'badge badge-err' };
    case 'unreachable':
      return { text: '未连校园网', cls: 'badge badge-idle' };
    case 'not_configured':
      return { text: '待配置', cls: 'badge badge-idle' };
    case 'logged_in_offline':
    case 'not_logged_in':
      return { text: '未上线', cls: 'badge badge-warn' };
    default:
      return { text: '未检测', cls: 'badge badge-idle' };
  }
}

function setBusy(busy) {
  els.btnRunNow.disabled = busy;
  els.btnRefresh.disabled = busy;
  els.btnOffline.disabled = busy;
  els.btnSave.disabled = busy;
}

function renderStatus(runtimeState) {
  const res = runtimeState?.lastResult;
  const badge = getBadgeStyle(res?.status);
  els.statusBadge.textContent = badge.text;
  els.statusBadge.className = badge.cls;

  els.statusMessage.textContent = res?.message || '尚未执行检测，点击“刷新状态”或“立即登录上线”。';
  els.metaIp.textContent = res?.ip || '-';
  els.metaPackage.textContent = res?.activePackage || '-';
  els.metaOnlineCount.textContent = res?.maxOnlineCount
    ? `${(res.onlineDevices || []).length} / ${res.maxOnlineCount}`
    : '-';
  els.metaTime.textContent = formatTime(runtimeState?.lastCheckedAt);

  if (runtimeState?.pausedReason === 'auth_failed') {
    els.pauseBanner.textContent = '已暂停自动重试：账号或密码校验失败。请修改后点击“保存设置”或“立即登录上线”。';
    els.pauseBanner.classList.remove('hidden');
  } else if (
    runtimeState?.pausedReason === 'need_manual_verify' &&
    runtimeState?.pausedUntil > Date.now()
  ) {
    els.pauseBanner.textContent = '已暂停自动重试（10分钟冷却）：需要手动完成扫码或语音验证，请打开认证页处理。';
    els.pauseBanner.classList.remove('hidden');
  } else {
    els.pauseBanner.classList.add('hidden');
  }

  const devices = res?.onlineDevices || [];
  if (devices.length > 0) {
    els.onlineDevicesBox.textContent = `当前在线设备：${devices
      .map((d) => `${d.ip}${d.ip === res.ip ? ' (本机)' : ''}`)
      .join('、')}`;
    els.onlineDevicesBox.classList.remove('hidden');
  } else {
    els.onlineDevicesBox.classList.add('hidden');
  }

  const pkgs = res?.availablePackages || [];
  els.packageChips.replaceChildren();
  if (pkgs.length > 0) {
    for (const pkgName of pkgs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.textContent = pkgName;
      btn.addEventListener('click', () => {
        els.preferredPackage.value = pkgName;
      });
      els.packageChips.appendChild(btn);
    }
    els.packageChips.classList.remove('hidden');
  } else {
    els.packageChips.classList.add('hidden');
  }

  const logs = runtimeState?.logs || [];
  els.logsList.replaceChildren();
  if (logs.length === 0) {
    const li = document.createElement('li');
    li.className = 'log-empty';
    li.textContent = '暂无记录';
    els.logsList.appendChild(li);
  } else {
    for (const item of logs.slice(0, 10)) {
      const li = document.createElement('li');
      li.className = 'log-item';
      const timeSpan = document.createElement('span');
      timeSpan.className = 'log-time';
      timeSpan.textContent = `[${formatTime(item.time)}]`;
      const msgSpan = document.createElement('span');
      msgSpan.textContent = item.message || item.status;
      li.appendChild(timeSpan);
      li.appendChild(msgSpan);
      els.logsList.appendChild(li);
    }
  }
}

function populateSettings(settings) {
  els.enabled.checked = Boolean(settings.enabled);
  els.accountType.value = settings.accountType === 'visitor' ? 'visitor' : 'normal';
  els.username.value = settings.username || '';
  els.password.value = settings.password || '';
  els.preferredPackage.value = settings.preferredPackage || '';
  els.autoKickOtherDevice.checked = Boolean(settings.autoKickOtherDevice);
  els.checkIntervalMinutes.value = String(settings.checkIntervalMinutes || 1);
  els.showNotifications.checked = Boolean(settings.showNotifications);
}

function collectSettingsFromForm() {
  return {
    enabled: els.enabled.checked,
    accountType: els.accountType.value,
    username: els.username.value.trim(),
    password: els.password.value,
    preferredPackage: els.preferredPackage.value.trim(),
    autoKickOtherDevice: els.autoKickOtherDevice.checked,
    checkIntervalMinutes: Number(els.checkIntervalMinutes.value) || 1,
    showNotifications: els.showNotifications.checked,
  };
}

async function saveCurrentSettings() {
  const settings = collectSettingsFromForm();
  const res = await sendMessage({ type: 'SAVE_SETTINGS', settings });
  if (res.ok) {
    els.saveTip.textContent = '已保存';
    setTimeout(() => {
      els.saveTip.textContent = '';
    }, 2500);
    if (res.runtimeState) {
      renderStatus(res.runtimeState);
    }
  }
  return res;
}

async function init() {
  const state = await sendMessage({ type: 'GET_STATE' });
  if (state.ok) {
    populateSettings(state.settings);
    renderStatus(state.runtimeState);
  }
}

els.btnTogglePwd.addEventListener('click', () => {
  const isPwd = els.password.type === 'password';
  els.password.type = isPwd ? 'text' : 'password';
  els.btnTogglePwd.textContent = isPwd ? '隐藏' : '显示';
});

els.settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  setBusy(true);
  try {
    await saveCurrentSettings();
  } finally {
    setBusy(false);
  }
});

els.btnRunNow.addEventListener('click', async () => {
  setBusy(true);
  els.statusMessage.textContent = '正在执行自动登录与上线…';
  try {
    await saveCurrentSettings();
    const res = await sendMessage({ type: 'RUN_NOW' });
    if (res.ok && res.runtimeState) {
      renderStatus(res.runtimeState);
    } else if (!res.ok) {
      els.statusMessage.textContent = `执行失败：${res.error || '未知错误'}`;
    }
  } finally {
    setBusy(false);
  }
});

els.btnRefresh.addEventListener('click', async () => {
  setBusy(true);
  els.statusMessage.textContent = '正在刷新状态…';
  try {
    const res = await sendMessage({ type: 'CHECK_STATUS' });
    if (res.ok && res.runtimeState) {
      renderStatus(res.runtimeState);
    }
  } finally {
    setBusy(false);
  }
});

els.btnOffline.addEventListener('click', async () => {
  setBusy(true);
  els.statusMessage.textContent = '正在下线本机…';
  try {
    const res = await sendMessage({ type: 'OFFLINE_ME' });
    if (res.ok && res.runtimeState) {
      renderStatus(res.runtimeState);
    }
  } finally {
    setBusy(false);
  }
});

els.btnOpenPortal.addEventListener('click', () => {
  chrome.tabs.create({ url: PORTAL_URL });
});

els.btnClearLogs.addEventListener('click', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  const res = await sendMessage({ type: 'CLEAR_LOGS' });
  if (res.ok && res.runtimeState) {
    renderStatus(res.runtimeState);
  }
});

init();
