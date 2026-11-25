import {
  ensureOnline,
  fetchCurrentStatus,
  offlineCurrentDevice,
} from './lib/webcc.js';

const ALARM_NAME = 'webcc-auto-check';
const MAX_LOG_ENTRIES = 20;
const MANUAL_VERIFY_COOLDOWN_MS = 10 * 60 * 1000;

export const DEFAULT_SETTINGS = {
  enabled: true,
  accountType: 'normal',
  username: '',
  password: '',
  preferredPackage: '',
  autoKickOtherDevice: false,
  checkIntervalMinutes: 1,
  showNotifications: true,
};

const DEFAULT_RUNTIME_STATE = {
  lastResult: null,
  lastCheckedAt: null,
  pausedReason: null,
  pausedUntil: null,
  lastNotifiedKey: null,
  logs: [],
};

let activeRunPromise = null;

async function getStorageData() {
  const stored = await chrome.storage.local.get(['settings', 'runtimeState']);
  return {
    settings: { ...DEFAULT_SETTINGS, ...(stored.settings || {}) },
    runtimeState: { ...DEFAULT_RUNTIME_STATE, ...(stored.runtimeState || {}) },
  };
}

async function saveRuntimeState(nextState) {
  await chrome.storage.local.set({ runtimeState: nextState });
}

function appendLog(logs, entry) {
  const next = [entry, ...(Array.isArray(logs) ? logs : [])];
  return next.slice(0, MAX_LOG_ENTRIES);
}

function updateBadge(status) {
  let text = '';
  let color = '#64748b';

  switch (status) {
    case 'already_online':
    case 'online_success':
      text = 'ON';
      color = '#16a34a';
      break;
    case 'device_limit':
      text = '满';
      color = '#d97706';
      break;
    case 'need_manual_verify':
      text = '验';
      color = '#d97706';
      break;
    case 'auth_failed':
    case 'error':
      text = '!';
      color = '#dc2626';
      break;
    default:
      text = '';
      break;
  }

  chrome.action.setBadgeText({ text });
  if (text) {
    chrome.action.setBadgeBackgroundColor({ color });
  }
}

function maybeNotify(settings, runtimeState, result) {
  if (!settings.showNotifications) {
    return runtimeState.lastNotifiedKey;
  }

  let notifyKey = null;
  let title = '';
  let message = '';

  if (result.status === 'online_success' && result.didAction) {
    notifyKey = `online_success:${result.ip || ''}:${result.activePackage || ''}:${Math.floor(Date.now() / 60000)}`;
    title = '校园网已自动上线';
    message = `${result.message}${result.ip ? `（本机 IP: ${result.ip}）` : ''}`;
  } else if (result.status === 'auth_failed') {
    notifyKey = `auth_failed:${result.message}`;
    title = '校园网自动登录失败';
    message = `${result.message}（已暂停自动重试，请检查账号密码）`;
  } else if (result.status === 'need_manual_verify') {
    notifyKey = `need_manual_verify:${result.message}`;
    title = '需要人工验证';
    message = result.message || '请打开认证页完成扫码或语音验证';
  } else if (result.status === 'device_limit') {
    notifyKey = `device_limit:${(result.onlineDevices || []).map((d) => d.ip).join(',')}`;
    title = '校园网设备数已满';
    message = result.message;
  } else if (result.status === 'already_online') {
    return null;
  } else {
    return runtimeState.lastNotifiedKey;
  }

  if (notifyKey && notifyKey !== runtimeState.lastNotifiedKey) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message,
    });
    return notifyKey;
  }

  return runtimeState.lastNotifiedKey;
}

function isAutoPaused(runtimeState) {
  if (!runtimeState.pausedReason) return false;
  if (runtimeState.pausedReason === 'auth_failed') return true;
  if (runtimeState.pausedReason === 'need_manual_verify') {
    return Boolean(runtimeState.pausedUntil && Date.now() < runtimeState.pausedUntil);
  }
  return false;
}

async function ensureAlarmScheduled(intervalMinutes) {
  const periodInMinutes = Math.max(1, Number(intervalMinutes) || 1);
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing || existing.periodInMinutes !== periodInMinutes) {
    await chrome.alarms.clear(ALARM_NAME);
    chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: periodInMinutes,
      periodInMinutes,
    });
  }
}

async function runEnsureOnline({ trigger = 'auto', bypassPause = false } = {}) {
  if (activeRunPromise) {
    return activeRunPromise;
  }

  activeRunPromise = (async () => {
    const { settings, runtimeState } = await getStorageData();

    if (!bypassPause && !settings.enabled) {
      return {
        skipped: true,
        reason: 'disabled',
        result: runtimeState.lastResult,
      };
    }

    if (!bypassPause && isAutoPaused(runtimeState)) {
      return {
        skipped: true,
        reason: runtimeState.pausedReason,
        result: runtimeState.lastResult,
      };
    }

    const result = await ensureOnline(settings);
    const now = Date.now();

    let pausedReason = null;
    let pausedUntil = null;
    if (result.status === 'auth_failed') {
      pausedReason = 'auth_failed';
    } else if (result.status === 'need_manual_verify') {
      pausedReason = 'need_manual_verify';
      pausedUntil = now + MANUAL_VERIFY_COOLDOWN_MS;
    }

    const shouldLog =
      bypassPause ||
      result.didAction ||
      result.status !== runtimeState.lastResult?.status;

    const logs = shouldLog
      ? appendLog(runtimeState.logs, {
          time: now,
          trigger,
          status: result.status,
          message: result.message,
          ip: result.ip || '',
        })
      : runtimeState.logs;

    const nextNotifiedKey = maybeNotify(settings, runtimeState, result);
    const nextState = {
      lastResult: result,
      lastCheckedAt: now,
      pausedReason,
      pausedUntil,
      lastNotifiedKey: nextNotifiedKey,
      logs,
    };

    await saveRuntimeState(nextState);
    updateBadge(result.status);

    return {
      skipped: false,
      result,
      runtimeState: nextState,
    };
  })();

  try {
    return await activeRunPromise;
  } finally {
    activeRunPromise = null;
  }
}

async function runReadOnlyCheck() {
  const { runtimeState } = await getStorageData();
  const result = await fetchCurrentStatus();
  const now = Date.now();

  const nextState = {
    ...runtimeState,
    lastResult: result,
    lastCheckedAt: now,
  };
  await saveRuntimeState(nextState);
  updateBadge(result.status);
  return { result, runtimeState: nextState };
}

async function runOfflineCurrent() {
  const { runtimeState } = await getStorageData();
  const result = await offlineCurrentDevice();
  const now = Date.now();

  const nextState = {
    ...runtimeState,
    lastResult: result,
    lastCheckedAt: now,
    logs: appendLog(runtimeState.logs, {
      time: now,
      trigger: 'manual_offline',
      status: result.status,
      message: result.message,
      ip: result.ip || '',
    }),
  };
  await saveRuntimeState(nextState);
  updateBadge(result.status);
  return { result, runtimeState: nextState };
}

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await getStorageData();
  await ensureAlarmScheduled(settings.checkIntervalMinutes);
  if (settings.enabled && settings.username && settings.password) {
    await runEnsureOnline({ trigger: 'installed' });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const { settings } = await getStorageData();
  await ensureAlarmScheduled(settings.checkIntervalMinutes);
  if (settings.enabled && settings.username && settings.password) {
    await runEnsureOnline({ trigger: 'startup' });
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await runEnsureOnline({ trigger: 'alarm' });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'GET_STATE': {
        const data = await getStorageData();
        sendResponse({ ok: true, ...data });
        break;
      }
      case 'SAVE_SETTINGS': {
        const { settings: current, runtimeState } = await getStorageData();
        const nextSettings = {
          ...current,
          ...(message.settings || {}),
          username: String(message.settings?.username ?? current.username).trim(),
          preferredPackage: String(
            message.settings?.preferredPackage ?? current.preferredPackage,
          ).trim(),
          checkIntervalMinutes: Math.max(
            1,
            Number(message.settings?.checkIntervalMinutes ?? current.checkIntervalMinutes) || 1,
          ),
        };
        const nextRuntime = {
          ...runtimeState,
          pausedReason: null,
          pausedUntil: null,
          lastNotifiedKey: null,
        };
        await chrome.storage.local.set({
          settings: nextSettings,
          runtimeState: nextRuntime,
        });
        await ensureAlarmScheduled(nextSettings.checkIntervalMinutes);
        sendResponse({ ok: true, settings: nextSettings, runtimeState: nextRuntime });
        break;
      }
      case 'RUN_NOW': {
        const outcome = await runEnsureOnline({ trigger: 'manual', bypassPause: true });
        sendResponse({ ok: true, ...outcome });
        break;
      }
      case 'CHECK_STATUS': {
        const outcome = await runReadOnlyCheck();
        sendResponse({ ok: true, ...outcome });
        break;
      }
      case 'OFFLINE_ME': {
        const outcome = await runOfflineCurrent();
        sendResponse({ ok: true, ...outcome });
        break;
      }
      case 'CLEAR_LOGS': {
        const { runtimeState } = await getStorageData();
        const nextRuntime = { ...runtimeState, logs: [] };
        await saveRuntimeState(nextRuntime);
        sendResponse({ ok: true, runtimeState: nextRuntime });
        break;
      }
      case 'PAGE_TRIGGER': {
        const outcome = await runEnsureOnline({ trigger: 'page', bypassPause: false });
        const result = outcome?.result || null;
        const shouldReload = Boolean(
          !outcome?.skipped &&
            result &&
            result.status === 'online_success' &&
            result.didAction,
        );
        sendResponse({
          ok: true,
          skipped: Boolean(outcome?.skipped),
          reason: outcome?.reason || null,
          result,
          shouldReload,
        });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'Unknown message type' });
    }
  })().catch((err) => {
    sendResponse({ ok: false, error: String(err?.message || err) });
  });

  return true;
});
