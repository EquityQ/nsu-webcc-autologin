import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptWebCCPassword } from '../lib/des.js';
import { ensureOnline, fetchCurrentStatus, offlineCurrentDevice } from '../lib/webcc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function createMockFetch(handler) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    const res = await handler(body, calls.length - 1);
    if (res instanceof Error) {
      throw res;
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return res;
      },
    };
  };
  fetchFn.calls = calls;
  return fetchFn;
}

const instantSleep = async () => {};

// 1. DES-ECB-PKCS7 ground-truth test vectors (verified against .NET System.Security.Cryptography.DES)
{
  assert.equal(
    encryptWebCCPassword('20220001', 'Pass@1234'),
    '3323547922cb8c62e510d1ec8460b269',
    'Vector 1 failed',
  );
  assert.equal(
    encryptWebCCPassword('123456', '12345678'),
    'b9061d46e210670bb25b18ad6d03124f',
    'Vector 2 (8-byte PKCS7 padding block) failed',
  );
  assert.equal(
    encryptWebCCPassword('V13800138000', 'abc'),
    'd38ff73d35e7da50',
    'Vector 3 (visitor prefix) failed',
  );
  assert.equal(encryptWebCCPassword('1', '').length, 16, 'Empty password should produce 1 block (16 hex chars)');
  console.log('[PASS] DES-ECB-PKCS7 ground-truth vectors');
}

// 2. Config missing -> not_configured
{
  const res = await ensureOnline({ username: '', password: '' });
  assert.equal(res.status, 'not_configured');
  console.log('[PASS] not_configured');
}

// 3. Unreachable network -> unreachable
{
  const fetchFn = createMockFetch(() => new Error('ECONNREFUSED'));
  const res = await ensureOnline({ username: '20220001', password: 'secret' }, { fetchFn });
  assert.equal(res.status, 'unreachable');
  console.log('[PASS] unreachable');
}

// 4. Already online -> already_online (no Login or OpenNet)
{
  const fetchFn = createMockFetch((body) => {
    if (body.DoWhat === 'Check') return { Result: true, Message: 'ok' };
    if (body.DoWhat === 'GetInfo') {
      return {
        Result: true,
        Data: {
          IP: '10.1.1.10',
          MAC: 'aabbccddeeff',
          XM: '测试同学',
          UG: '学生组',
          MOC: 1,
          KXTC: [{ 套餐名称: '学生-移动-200M' }],
          OIA: [{ IP: '10.1.1.10', MAC: 'aabbccddeeff', Package: { 套餐名称: '学生-移动-200M' } }],
        },
      };
    }
    throw new Error(`Unexpected DoWhat: ${body.DoWhat}`);
  });
  const res = await ensureOnline({ username: '20220001', password: 'secret' }, { fetchFn });
  assert.equal(res.status, 'already_online');
  assert.equal(res.didAction, false);
  assert.equal(res.ip, '10.1.1.10');
  assert.equal(res.activePackage, '学生-移动-200M');
  console.log('[PASS] already_online');
}

// 5. Full flow: Check(false) -> Login(true) -> GetInfo(offline) -> OpenNet(true) -> GetInfo(online)
{
  let loggedIn = false;
  let online = false;
  const fetchFn = createMockFetch((body) => {
    if (body.DoWhat === 'Check') return { Result: loggedIn, Message: loggedIn ? 'ok' : 'need login' };
    if (body.DoWhat === 'Login') {
      assert.equal(body.username, 'V13800138000');
      assert.equal(body.password, 'd38ff73d35e7da50');
      loggedIn = true;
      return { Result: true, Message: '登录成功' };
    }
    if (body.DoWhat === 'GetInfo') {
      return {
        Result: true,
        Data: {
          IP: '10.1.1.20',
          MAC: '112233445566',
          MOC: 1,
          KXTC: [{ 套餐名称: '套餐A' }, { 套餐名称: '套餐B' }],
          OIA: online ? [{ IP: '10.1.1.20', MAC: '112233445566', Package: { 套餐名称: '套餐B' } }] : [],
        },
      };
    }
    if (body.DoWhat === 'OpenNet') {
      assert.equal(body.Package, '套餐B');
      online = true;
      return { Result: true, Message: '上线成功' };
    }
    throw new Error(`Unexpected DoWhat: ${body.DoWhat}`);
  });

  const res = await ensureOnline(
    {
      accountType: 'visitor',
      username: '13800138000',
      password: 'abc',
      preferredPackage: '套餐B',
    },
    { fetchFn },
  );
  assert.equal(res.status, 'online_success');
  assert.equal(res.didAction, true);
  assert.equal(res.activePackage, '套餐B');
  console.log('[PASS] full login + visitor prefix + preferredPackage + OpenNet');
}

// 6. Device limit with autoKickOtherDevice = false (must NOT call CloseNet)
{
  const fetchFn = createMockFetch((body) => {
    if (body.DoWhat === 'Check') return { Result: true };
    if (body.DoWhat === 'GetInfo') {
      return {
        Result: true,
        Data: {
          IP: '10.1.1.30',
          MOC: 1,
          KXTC: [{ 套餐名称: '套餐A' }],
          OIA: [{ IP: '10.1.1.99', MAC: '999999999999', Package: { 套餐名称: '套餐A' } }],
        },
      };
    }
    if (body.DoWhat === 'CloseNet') throw new Error('CloseNet must not be called when autoKickOtherDevice is false');
    throw new Error(`Unexpected DoWhat: ${body.DoWhat}`);
  });

  const res = await ensureOnline(
    { username: '20220001', password: 'secret', autoKickOtherDevice: false },
    { fetchFn },
  );
  assert.equal(res.status, 'device_limit');
  assert.equal(fetchFn.calls.some((c) => c.body.DoWhat === 'CloseNet'), false);
  console.log('[PASS] device_limit without kicking');
}

// 7. Device limit with autoKickOtherDevice = true (CloseNet old IP then OpenNet)
{
  let oia = [{ IP: '10.1.1.99', MAC: '999999999999', Package: { 套餐名称: '套餐A' } }];
  const fetchFn = createMockFetch((body) => {
    if (body.DoWhat === 'Check') return { Result: true };
    if (body.DoWhat === 'GetInfo') {
      return {
        Result: true,
        Data: { IP: '10.1.1.30', MOC: 1, KXTC: [{ 套餐名称: '套餐A' }], OIA: oia },
      };
    }
    if (body.DoWhat === 'CloseNet') {
      assert.equal(body.IP, '10.1.1.99');
      oia = [];
      return { Result: true, Message: '已下线' };
    }
    if (body.DoWhat === 'OpenNet') {
      oia = [{ IP: '10.1.1.30', MAC: '303030303030', Package: { 套餐名称: '套餐A' } }];
      return { Result: true, Message: '上线成功' };
    }
    throw new Error(`Unexpected DoWhat: ${body.DoWhat}`);
  });

  const res = await ensureOnline(
    { username: '20220001', password: 'secret', autoKickOtherDevice: true },
    { fetchFn },
  );
  assert.equal(res.status, 'online_success');
  assert.equal(res.didAction, true);
  assert.equal(res.ip, '10.1.1.30');
  console.log('[PASS] autoKickOtherDevice = true');
}

// 8. Result 192 + ReConnect polling (wait -> transient network error -> true)
{
  let rcStep = 0;
  let isOnline = false;
  const fetchFn = createMockFetch((body) => {
    if (body.DoWhat === 'Check') return { Result: true };
    if (body.DoWhat === 'GetInfo') {
      return {
        Result: true,
        Data: {
          IP: '10.1.1.40',
          MOC: 1,
          KXTC: [{ 套餐名称: '套餐A' }],
          OIA: isOnline ? [{ IP: '10.1.1.40', Package: { 套餐名称: '套餐A' } }] : [],
        },
      };
    }
    if (body.DoWhat === 'OpenNet') {
      return { Result: 192, Token: 'tok-xyz', Sec: 10, Message: '正在切换网段' };
    }
    if (body.DoWhat === 'ReConnect') {
      assert.equal(body.Token, 'tok-xyz');
      rcStep += 1;
      if (rcStep === 1) return { Result: 'wait' };
      if (rcStep === 2) return new Error('temporary drop during VLAN switch');
      isOnline = true;
      return { Result: true, Message: '切换并上线成功!' };
    }
    throw new Error(`Unexpected DoWhat: ${body.DoWhat}`);
  });

  const res = await ensureOnline(
    { username: '20220001', password: 'secret' },
    { fetchFn, sleepFn: instantSleep, reconnectIntervalMs: 50 },
  );
  assert.equal(res.status, 'online_success');
  assert.equal(res.didAction, true);
  assert.equal(rcStep, 3);
  console.log('[PASS] Result 192 + ReConnect polling');
}

// 9. needQRLogin & voice verification detection & auth_failed
{
  const qrFetch = createMockFetch(() => ({ Result: 'needQRLogin', Message: '请扫码登录' }));
  const qrRes = await ensureOnline({ username: '20220001', password: 'secret' }, { fetchFn: qrFetch });
  assert.equal(qrRes.status, 'need_manual_verify');

  const voiceFetch = createMockFetch((body) => {
    if (body.DoWhat === 'Check') return { Result: true };
    if (body.DoWhat === 'GetInfo') {
      return { Result: true, Data: { IP: '10.1.1.50', MOC: 1, KXTC: [{ 套餐名称: '套餐A' }], OIA: [] } };
    }
    if (body.DoWhat === 'OpenNet') {
      return { Result: false, Message: '新设备需完成电话语音验证后才能上线！' };
    }
    throw new Error(`Unexpected DoWhat: ${body.DoWhat}`);
  });
  const voiceRes = await ensureOnline({ username: '20220001', password: 'secret' }, { fetchFn: voiceFetch });
  assert.equal(voiceRes.status, 'need_manual_verify');

  const authFetch = createMockFetch((body) => {
    if (body.DoWhat === 'Check') return { Result: false };
    if (body.DoWhat === 'Login') return { Result: false, Message: '用户名或密码错误' };
    throw new Error(`Unexpected DoWhat: ${body.DoWhat}`);
  });
  const authRes = await ensureOnline({ username: '20220001', password: 'wrong' }, { fetchFn: authFetch });
  assert.equal(authRes.status, 'auth_failed');
  console.log('[PASS] needQRLogin, manual verification, and auth_failed');
}

// 10. fetchCurrentStatus and offlineCurrentDevice
{
  let oia = [{ IP: '10.1.1.60', Package: { 套餐名称: '套餐A' } }];
  const fetchFn = createMockFetch((body) => {
    if (body.DoWhat === 'GetInfo') {
      return { Result: true, Data: { IP: '10.1.1.60', MOC: 1, KXTC: [{ 套餐名称: '套餐A' }], OIA: oia } };
    }
    if (body.DoWhat === 'CloseNet') {
      oia = [];
      return { Result: true, Message: '已下线本机' };
    }
    throw new Error(`Unexpected DoWhat: ${body.DoWhat}`);
  });
  const st = await fetchCurrentStatus({ fetchFn });
  assert.equal(st.status, 'already_online');
  const off = await offlineCurrentDevice({ fetchFn });
  assert.equal(off.status, 'logged_in_offline');
  assert.equal(off.didAction, true);
  console.log('[PASS] fetchCurrentStatus and offlineCurrentDevice');
}

// 11. Validate manifest.json and referenced files
{
  const manifestPath = path.join(rootDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.manifest_version, 3);

  const filesToCheck = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
    ...(manifest.content_scripts || []).flatMap((cs) => cs.js || []),
  ].filter(Boolean);

  for (const rel of filesToCheck) {
    const full = path.join(rootDir, rel);
    assert.equal(fs.existsSync(full), true, `Missing referenced file: ${rel}`);
  }

  // Ensure popup.html has no inline <script> blocks or inline event handlers
  const popupHtml = fs.readFileSync(path.join(rootDir, 'popup.html'), 'utf8');
  assert.equal(/<script(?![^>]*\bsrc=)/i.test(popupHtml), false, 'popup.html must not contain inline script');
  assert.equal(/\son\w+\s*=/i.test(popupHtml), false, 'popup.html must not contain inline event handlers');
  console.log('[PASS] manifest.json & MV3 CSP checks');
}

console.log('ALL TESTS PASSED');
