(() => {
  const TOAST_ID = 'webcc-autologin-toast';
  const RELOAD_STORAGE_KEY = 'webcc_ext_last_reload';
  const RELOAD_COOLDOWN_MS = 15000;

  function showToast(text, variant = 'info', autoHideMs = 6000) {
    let el = document.getElementById(TOAST_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = TOAST_ID;
      Object.assign(el.style, {
        position: 'fixed',
        top: '16px',
        right: '16px',
        zIndex: '999999',
        maxWidth: '340px',
        padding: '10px 14px',
        borderRadius: '10px',
        fontFamily: 'system-ui, -apple-system, "Microsoft YaHei", sans-serif',
        fontSize: '13px',
        lineHeight: '1.5',
        color: '#ffffff',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.25)',
        display: 'flex',
        alignItems: 'flex-start',
        gap: '10px',
        transition: 'opacity 0.25s ease',
      });
      document.body.appendChild(el);
    }

    const bgMap = {
      success: 'rgba(22, 163, 74, 0.94)',
      warning: 'rgba(217, 119, 6, 0.94)',
      error: 'rgba(220, 38, 38, 0.94)',
      info: 'rgba(22, 119, 255, 0.94)',
    };
    el.style.background = bgMap[variant] || bgMap.info;
    el.style.opacity = '1';
    el.replaceChildren();

    const msgSpan = document.createElement('span');
    msgSpan.textContent = text;
    msgSpan.style.flex = '1';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '×';
    Object.assign(closeBtn.style, {
      background: 'transparent',
      border: 'none',
      color: '#ffffff',
      fontSize: '16px',
      lineHeight: '1',
      cursor: 'pointer',
      padding: '0 2px',
    });
    closeBtn.addEventListener('click', () => {
      el.remove();
    });

    el.appendChild(msgSpan);
    el.appendChild(closeBtn);

    if (autoHideMs > 0) {
      setTimeout(() => {
        if (el.isConnected) {
          el.style.opacity = '0';
          setTimeout(() => el.remove(), 250);
        }
      }, autoHideMs);
    }
  }

  function canReloadNow() {
    try {
      const last = Number(sessionStorage.getItem(RELOAD_STORAGE_KEY) || 0);
      return Date.now() - last > RELOAD_COOLDOWN_MS;
    } catch {
      return false;
    }
  }

  function markReloaded() {
    try {
      sessionStorage.setItem(RELOAD_STORAGE_KEY, String(Date.now()));
    } catch {
      // ignore storage errors
    }
  }

  chrome.runtime.sendMessage({ type: 'PAGE_TRIGGER' }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      return;
    }

    const result = response.result;
    if (!result) return;

    if (response.skipped) {
      if (response.reason === 'auth_failed') {
        showToast('WebCC 自动登录已暂停：账号或密码错误，请在插件弹窗修改后重试。', 'error', 9000);
      }
      return;
    }

    if (result.status === 'not_configured') {
      showToast('WebCC 自动认证：请点击浏览器右上角插件图标填写账号和密码。', 'info', 7000);
      return;
    }

    if (result.status === 'online_success' && response.shouldReload) {
      if (canReloadNow()) {
        markReloaded();
        showToast(`${result.message}，正在刷新页面…`, 'success', 4000);
        setTimeout(() => location.reload(), 800);
      } else {
        showToast(result.message, 'success', 5000);
      }
      return;
    }

    if (result.status === 'already_online') {
      showToast(`WebCC 自动认证：本机已在线（${result.ip || ''}）`, 'success', 3500);
      return;
    }

    if (result.status === 'device_limit') {
      showToast(`WebCC 自动认证：${result.message}`, 'warning', 9000);
      return;
    }

    if (result.status === 'need_manual_verify') {
      showToast(`WebCC 需要手动验证：${result.message}`, 'warning', 10000);
      return;
    }

    if (result.status === 'auth_failed' || result.status === 'error') {
      showToast(`WebCC 自动认证：${result.message}`, 'error', 9000);
    }
  });
})();
