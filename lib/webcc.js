import { encryptWebCCPassword } from './des.js';

export const AUTH_URL = 'https://cc.nsu.edu.cn/Auth.ashx';
export const PORTAL_URL = 'https://cc.nsu.edu.cn/';
export const DEFAULT_TIMEOUT_MS = 6000;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Format login username according to WebCC rules.
 * Visitor accounts use "V" + phone number.
 */
export function formatLoginUsername(username, accountType = 'normal') {
  const trimmed = String(username || '').trim();
  if (!trimmed) return '';
  if (accountType === 'visitor' && !trimmed.startsWith('V')) {
    return `V${trimmed}`;
  }
  return trimmed;
}

/**
 * Pick preferred package if available, otherwise fallback to the first package.
 */
export function selectPackageName(kxtcList, preferredPackage = '') {
  if (!Array.isArray(kxtcList) || kxtcList.length === 0) {
    return null;
  }
  const preferred = String(preferredPackage || '').trim();
  if (preferred) {
    const matched = kxtcList.find(
      (item) => String(item?.['套餐名称'] || '').trim() === preferred,
    );
    if (matched) {
      return matched['套餐名称'];
    }
  }
  const first = kxtcList.find((item) => Boolean(item?.['套餐名称']));
  return first ? first['套餐名称'] : null;
}

/**
 * Detect server messages that require manual phone/voice/QR verification.
 */
export function isManualVerificationMessage(message) {
  const text = String(message || '');
  return /电话|语音|扫码|二维码|微信|钉钉|人工验证|安全验证/.test(text);
}

/**
 * POST JSON payload to WebCC Auth.ashx with timeout handling.
 */
export async function postAuth(payload, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = options.authUrl || AUTH_URL;

  if (typeof fetchFn !== 'function') {
    return { ok: false, networkError: true, error: 'fetch is not available' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        ok: false,
        networkError: true,
        statusCode: response.status,
        error: `HTTP ${response.status}`,
      };
    }

    const data = await response.json();
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      networkError: true,
      error: err?.name === 'AbortError' ? '请求超时' : String(err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildResult(partial) {
  return {
    status: 'error',
    message: '',
    didAction: false,
    ip: '',
    mac: '',
    activePackage: '',
    onlineDevices: [],
    availablePackages: [],
    maxOnlineCount: 0,
    userName: '',
    userGroup: '',
    rawMessage: '',
    ...partial,
  };
}

function mapInfoFields(infoData) {
  const d = infoData || {};
  const oia = Array.isArray(d.OIA) ? d.OIA : [];
  const kxtc = Array.isArray(d.KXTC) ? d.KXTC : [];
  const ip = String(d.IP || '');
  const currentOnline = oia.find((item) => item?.IP === ip);
  return {
    ip,
    mac: String(d.MAC || ''),
    userName: String(d.XM || ''),
    userGroup: String(d.UG || ''),
    maxOnlineCount: Number(d.MOC || 0),
    onlineDevices: oia.map((item) => ({
      ip: String(item?.IP || ''),
      mac: String(item?.MAC || ''),
      vlan: item?.VLAN ?? '',
      packageName: String(item?.Package?.['套餐名称'] || ''),
      start: String(item?.Start || ''),
    })),
    availablePackages: kxtc
      .map((item) => String(item?.['套餐名称'] || ''))
      .filter(Boolean),
    activePackage: String(currentOnline?.Package?.['套餐名称'] || ''),
  };
}

async function performLogin(loginUser, password, options) {
  const encryptedPassword = encryptWebCCPassword(loginUser, password);
  const res = await postAuth(
    {
      DoWhat: 'Login',
      username: loginUser,
      password: encryptedPassword,
      remember: false,
    },
    options,
  );
  if (!res.ok) {
    return { ok: false, unreachable: true, error: res.error };
  }
  const data = res.data || {};
  if (data.Result === true) {
    return { ok: true, message: String(data.Message || '登录成功') };
  }
  return {
    ok: false,
    unreachable: false,
    message: String(data.Message || '账号或密码错误'),
  };
}

/**
 * Read-only query of current WebCC session and online status.
 */
export async function fetchCurrentStatus(options = {}) {
  const infoRes = await postAuth({ DoWhat: 'GetInfo' }, options);
  if (!infoRes.ok) {
    return buildResult({
      status: 'unreachable',
      message: '当前未连接到校园网认证服务器（cc.nsu.edu.cn 不可达）',
      rawMessage: infoRes.error,
    });
  }

  const info = infoRes.data || {};
  if (info.Result === 'needLogin') {
    return buildResult({
      status: 'not_logged_in',
      message: String(info.Message || '当前尚未登录校园网'),
      rawMessage: String(info.Message || ''),
    });
  }

  if (info.Result !== true || !info.Data) {
    return buildResult({
      status: 'error',
      message: String(info.Message || '查询状态失败'),
      rawMessage: String(info.Message || ''),
    });
  }

  const fields = mapInfoFields(info.Data);
  const isOnline = Boolean(fields.ip && fields.onlineDevices.some((d) => d.ip === fields.ip));
  return buildResult({
    ...fields,
    status: isOnline ? 'already_online' : 'logged_in_offline',
    message: isOnline
      ? `本机已在线（IP: ${fields.ip}）`
      : `已登录但尚未上线网络（本机 IP: ${fields.ip || '未知'}）`,
    rawMessage: String(info.Message || ''),
  });
}

/**
 * Take the current device offline via CloseNet.
 */
export async function offlineCurrentDevice(options = {}) {
  const status = await fetchCurrentStatus(options);
  if (status.status !== 'already_online' || !status.ip) {
    return buildResult({
      ...status,
      didAction: false,
      message: status.status === 'unreachable'
        ? status.message
        : '本机当前未处于在线状态，无需下线',
    });
  }

  const closeRes = await postAuth({ DoWhat: 'CloseNet', IP: status.ip }, options);
  if (!closeRes.ok) {
    return buildResult({
      ...status,
      status: 'unreachable',
      message: '下线请求失败：无法连接认证服务器',
      rawMessage: closeRes.error,
    });
  }

  const data = closeRes.data || {};
  if (data.Result === true) {
    const refreshed = await fetchCurrentStatus(options);
    return buildResult({
      ...refreshed,
      status: 'logged_in_offline',
      didAction: true,
      message: String(data.Message || '已下线本机'),
      rawMessage: String(data.Message || ''),
    });
  }

  return buildResult({
    ...status,
    status: 'error',
    message: String(data.Message || '下线失败'),
    rawMessage: String(data.Message || ''),
  });
}

/**
 * Full WebCC auto-login & auto-online state machine.
 */
export async function ensureOnline(config, options = {}) {
  const sleepFn = options.sleepFn || defaultSleep;
  const reconnectIntervalMs = options.reconnectIntervalMs ?? 1500;
  const loginUser = formatLoginUsername(config?.username, config?.accountType);
  const password = String(config?.password ?? '');

  if (!loginUser || !password) {
    return buildResult({
      status: 'not_configured',
      message: '请先在插件设置中填写校园网账号和密码',
    });
  }

  let didAction = false;

  // Step 1: Check current auth session
  const checkRes = await postAuth({ DoWhat: 'Check' }, options);
  if (!checkRes.ok) {
    return buildResult({
      status: 'unreachable',
      message: '无法连接 cc.nsu.edu.cn（可能未连接校园网）',
      rawMessage: checkRes.error,
    });
  }

  const checkData = checkRes.data || {};
  if (checkData.Result === 'needQRLogin') {
    return buildResult({
      status: 'need_manual_verify',
      message: String(checkData.Message || '当前需要微信/钉钉扫码验证，请打开认证页手动完成'),
      rawMessage: String(checkData.Message || ''),
    });
  }

  if (checkData.Result !== true) {
    const loginRes = await performLogin(loginUser, password, options);
    if (!loginRes.ok) {
      return buildResult({
        status: loginRes.unreachable ? 'unreachable' : 'auth_failed',
        message: loginRes.unreachable
          ? '登录请求失败：无法连接 cc.nsu.edu.cn'
          : `登录失败：${loginRes.message}`,
        rawMessage: loginRes.message || loginRes.error || '',
      });
    }
    didAction = true;
  }

  // Step 2: GetInfo (retry login once if session expired between Check and GetInfo)
  let infoRes = await postAuth({ DoWhat: 'GetInfo' }, options);
  if (!infoRes.ok) {
    return buildResult({
      status: 'unreachable',
      message: '获取账号信息失败：无法连接 cc.nsu.edu.cn',
      rawMessage: infoRes.error,
    });
  }

  if (infoRes.data?.Result === 'needLogin') {
    const loginRes = await performLogin(loginUser, password, options);
    if (!loginRes.ok) {
      return buildResult({
        status: loginRes.unreachable ? 'unreachable' : 'auth_failed',
        message: loginRes.unreachable
          ? '登录请求失败：无法连接 cc.nsu.edu.cn'
          : `登录失败：${loginRes.message}`,
        rawMessage: loginRes.message || loginRes.error || '',
      });
    }
    didAction = true;
    infoRes = await postAuth({ DoWhat: 'GetInfo' }, options);
    if (!infoRes.ok) {
      return buildResult({
        status: 'unreachable',
        message: '登录后获取账号信息失败',
        rawMessage: infoRes.error,
      });
    }
  }

  if (infoRes.data?.Result !== true || !infoRes.data?.Data) {
    return buildResult({
      status: 'error',
      message: String(infoRes.data?.Message || '获取账号信息失败'),
      rawMessage: String(infoRes.data?.Message || ''),
    });
  }

  let infoData = infoRes.data.Data;
  let fields = mapInfoFields(infoData);

  // Already online?
  if (fields.ip && fields.onlineDevices.some((d) => d.ip === fields.ip)) {
    return buildResult({
      ...fields,
      status: didAction ? 'online_success' : 'already_online',
      didAction,
      message: didAction
        ? `已自动登录，本机已在线（${fields.ip}）`
        : `本机已在线（${fields.ip}）`,
    });
  }

  // Step 3: Check simultaneous online device limit
  const moc = fields.maxOnlineCount;
  if (moc > 0 && fields.onlineDevices.length >= moc) {
    if (!config?.autoKickOtherDevice) {
      const otherIps = fields.onlineDevices.map((d) => d.ip).filter(Boolean).join(', ');
      return buildResult({
        ...fields,
        status: 'device_limit',
        didAction,
        message: `已达同时在线上限（${fields.onlineDevices.length}/${moc}，当前在线 IP: ${otherIps || '未知'}），已按设置停止自动顶号`,
      });
    }

    const kickCandidates = fields.onlineDevices.filter((d) => d.ip && d.ip !== fields.ip);
    let currentCount = fields.onlineDevices.length;
    for (const candidate of kickCandidates) {
      if (currentCount < moc) break;
      const closeRes = await postAuth({ DoWhat: 'CloseNet', IP: candidate.ip }, options);
      if (!closeRes.ok || closeRes.data?.Result !== true) {
        return buildResult({
          ...fields,
          status: 'error',
          didAction,
          message: `下线旧设备 ${candidate.ip} 失败：${closeRes.data?.Message || closeRes.error || '未知错误'}`,
          rawMessage: String(closeRes.data?.Message || closeRes.error || ''),
        });
      }
      didAction = true;
      currentCount -= 1;
    }

    // Refresh GetInfo after kicking old devices
    const afterKickInfo = await postAuth({ DoWhat: 'GetInfo' }, options);
    if (afterKickInfo.ok && afterKickInfo.data?.Result === true && afterKickInfo.data?.Data) {
      infoData = afterKickInfo.data.Data;
      fields = mapInfoFields(infoData);
    }
  }

  // Step 4: Select package and OpenNet
  const pkgName = selectPackageName(infoData.KXTC, config?.preferredPackage);
  if (!pkgName) {
    return buildResult({
      ...fields,
      status: 'error',
      didAction,
      message: '当前账号没有可用的网络套餐，无法上线',
    });
  }

  const openRes = await postAuth({ DoWhat: 'OpenNet', Package: pkgName }, options);
  if (!openRes.ok) {
    return buildResult({
      ...fields,
      status: 'unreachable',
      didAction,
      message: '上线请求失败：网络通讯异常',
      rawMessage: openRes.error,
    });
  }

  const openData = openRes.data || {};
  if (openData.Result === true) {
    didAction = true;
    const latestInfo = await postAuth({ DoWhat: 'GetInfo' }, options);
    const finalFields =
      latestInfo.ok && latestInfo.data?.Result === true && latestInfo.data?.Data
        ? mapInfoFields(latestInfo.data.Data)
        : fields;

    return buildResult({
      ...finalFields,
      activePackage: finalFields.activePackage || pkgName,
      status: 'online_success',
      didAction: true,
      message: `自动上线成功（套餐：${pkgName}）`,
      rawMessage: String(openData.Message || ''),
    });
  }

  if (openData.Result === 'needLogin') {
    return buildResult({
      ...fields,
      status: 'auth_failed',
      didAction,
      message: String(openData.Message || '登录状态失效，请重试'),
      rawMessage: String(openData.Message || ''),
    });
  }

  if (openData.Result === 192) {
    // New device / VLAN switch reconnect polling
    didAction = true;
    const token = openData.Token;
    const maxSec = Math.max(Number(openData.Sec || 30), 10);
    const maxAttempts = Math.ceil((maxSec * 1000) / Math.max(reconnectIntervalMs, 50));

    for (let i = 0; i < maxAttempts; i++) {
      await sleepFn(reconnectIntervalMs);
      const rcRes = await postAuth({ DoWhat: 'ReConnect', Token: token }, options);
      if (!rcRes.ok) {
        // Network interface may briefly drop while switching VLAN; keep polling
        continue;
      }
      const rcData = rcRes.data || {};
      if (rcData.Result === true) {
        const latestInfo = await postAuth({ DoWhat: 'GetInfo' }, options);
        const finalFields =
          latestInfo.ok && latestInfo.data?.Result === true && latestInfo.data?.Data
            ? mapInfoFields(latestInfo.data.Data)
            : fields;
        return buildResult({
          ...finalFields,
          activePackage: finalFields.activePackage || pkgName,
          status: 'online_success',
          didAction: true,
          message: String(rcData.Message || `自动切换网络并上线成功（${pkgName}）`),
          rawMessage: String(rcData.Message || ''),
        });
      }
      if (rcData.Result === false) {
        const msg = String(rcData.Message || '切换网络上线失败');
        return buildResult({
          ...fields,
          status: isManualVerificationMessage(msg) ? 'need_manual_verify' : 'error',
          didAction: true,
          message: msg,
          rawMessage: msg,
        });
      }
      // Result === 'wait': continue polling
    }

    return buildResult({
      ...fields,
      status: 'error',
      didAction: true,
      message: '新设备切换网络上线超时，请打开认证页重试',
    });
  }

  const errMsg = String(openData.Message || '上线失败');
  if (isManualVerificationMessage(errMsg)) {
    return buildResult({
      ...fields,
      status: 'need_manual_verify',
      didAction,
      message: errMsg,
      rawMessage: errMsg,
    });
  }

  return buildResult({
    ...fields,
    status: 'error',
    didAction,
    message: errMsg,
    rawMessage: errMsg,
  });
}
