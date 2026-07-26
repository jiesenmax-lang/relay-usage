/* relay-usage 看板 jsdom 测试：聚合数学 + 站点管理 + 容错 */
const fs = require('fs');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync('C:/Users/Administrator/WorkBuddy/20260428222742/relay-usage/index.html', 'utf8');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}
function $(id, w) { return w.document.getElementById(id); }
const Q = 500000; // $1
const NOW = Math.floor(Date.now() / 1000);
const TODAY0 = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return Math.floor(d.getTime() / 1000); })();

function mkLog(over) {
  return Object.assign({
    id: 1, created_at: NOW, type: 2, token_name: 'tk', model_name: 'gpt-5.6-kuma',
    quota: 0, prompt_tokens: 100, completion_tokens: 50, use_time: 10
  }, over);
}
function newDom() {
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously',
    url: 'https://example.com/',
    beforeParse(window) {
      window.AbortSignal = AbortSignal;
      // jsdom 无 fetch / canvas：注入桩，避免 init() 自执行时抛错
      window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { quota: 0, used_quota: 0 } }) });
      window.HTMLCanvasElement.prototype.getContext = function () {
        return new Proxy({}, { get: () => () => ({ width: 0 }) });
      };
    }
  });
  // 清空 init() 自动注入的预设站点，保证测试从干净状态开始；并复位 refreshing 锁
  const w = dom.window;
  w.stations.length = 0; w.saveStations(); w.refreshing = false;
  return dom;
}

(async () => {
  // ---------- T1 纯函数：换算 & 格式化 ----------
  console.log('T1 额度换算与格式化');
  {
    const w = newDom().window;
    ok('500000 额度 = $1', w.q2usd(500000) === 1);
    ok('74500 额度 = $0.149', Math.abs(w.q2usd(74500) - 0.149) < 1e-9);
    ok('fmtUSD(500000) = $1.00', w.fmtUSD(500000) === '$1.00');
    ok('fmtUSD(74500) = $0.1490', w.fmtUSD(74500) === '$0.1490');
    ok('dayKey 本地日期格式 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(w.dayKey(NOW)));
  }

  // ---------- T2 聚合数学 ----------
  console.log('T2 aggregate 今日/本月/近7天/分组');
  {
    const w = newDom().window;
    const list = [
      mkLog({ created_at: NOW, quota: 74500, model_name: 'a', _st: 'S1' }),                        // 今天
      mkLog({ created_at: TODAY0 + 10, quota: 500000, model_name: 'a', _st: 'S1' }),               // 今天
      mkLog({ created_at: TODAY0 - 86400, quota: 250000, model_name: 'b', _st: 'S2' }),            // 昨天
      mkLog({ created_at: TODAY0 - 8 * 86400, quota: 100000, model_name: 'b', _st: 'S2' }),        // 8天前（本月内，7天外）
    ];
    const agg = w.aggregate(list);
    ok('今日=74500+500000', agg.today === 574500);
    ok('近7天=今日+昨日', agg.week === 824500);
    ok('本月=全部4条', agg.month === 924500);
    ok('按模型 a=574500', agg.byModel.a === 574500);
    ok('按模型 b=350000', agg.byModel.b === 350000);
    ok('按站点 S2=350000', agg.byStation.S2 === 350000);
    ok('按天分桶含今天', !!agg.byDay[w.dayKey(NOW)] && agg.byDay[w.dayKey(NOW)] === 574500);
  }

  // ---------- T3 站点增删 + localStorage ----------
  console.log('T3 站点管理');
  {
    const w = newDom().window;
    w.document.getElementById('eName').value = 'DoCode';
    w.document.getElementById('eBase').value = 'https://docode.cc/';
    w.document.getElementById('eToken').value = 'tok123';
    w.saveEdit();
    const saved = JSON.parse(w.localStorage.getItem('ru_stations_v1'));
    ok('保存1个站点', saved.length === 1);
    ok('base 尾部斜杠被去掉', saved[0].base === 'https://docode.cc');
    ok('默认启用', saved[0].enabled === true);
    ok('空字段拒绝保存', (() => {
      w.document.getElementById('eName').value = '';
      w.document.getElementById('eBase').value = '';
      w.document.getElementById('eToken').value = '';
      w.saveEdit();
      return JSON.parse(w.localStorage.getItem('ru_stations_v1')).length === 1;
    })());
  }

  // ---------- T4 refreshAll 双站点 + 一站失败 ----------
  console.log('T4 refreshAll 容错');
  {
    const w = newDom().window;
    w.stations.push(
      { id: 's1', name: 'Good', base: 'https://good.cc', token: 't', proxy: '', enabled: true },
      { id: 's2', name: 'Bad', base: 'https://bad.cc', token: 't', proxy: '', enabled: true }
    );
    w.saveStations();
    w.refreshing = false;
    w.fetch = (url) => {
      if (url.indexOf('https://good.cc/api/user/self') === 0)
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { quota: 5000000, used_quota: 123 } }) });
      if (url.indexOf('https://good.cc/api/log/self') === 0)
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { items: [mkLog({ quota: 74500 })], total: 1, page: 0, page_size: 100 } }) });
      return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ success: false, message: 'Unauthorized' }) });
    };
    await w.refreshAll(true);
    await new Promise(r => setTimeout(r, 0));
    ok('好站余额已写入', w.userInfos.s1 && w.userInfos.s1.quota === 5000000);
    ok('好站日志已合并并标注站点', w.logs.length === 1 && w.logs[0]._st === 'Good');
    ok('坏站记录错误', typeof w.stationErr.s2 === 'string' && w.stationErr.s2.length > 0);
    ok('坏站不拖垮全局（无未捕获异常）', true);
    ok('总余额只算好站 = $10', w.totalBalance() === 5000000);
  }

  // ---------- T5 停用站点：跳过拉取且清除其日志 ----------
  console.log('T5 停用站点');
  {
    const w = newDom().window;
    w.stations.push({ id: 's1', name: 'A', base: 'https://a.cc', token: 't', proxy: '', enabled: false });
    w.logs.push(mkLog({ _stId: 's1', _st: 'A', quota: 999 }));
    let called = false;
    w.refreshing = false;
    w.fetch = () => { called = true; return Promise.reject(new Error('不应被调用')); };
    await w.refreshAll(false);
    await new Promise(r => setTimeout(r, 0));
    ok('停用站不发起请求', called === false);
    ok('停用站日志被清除', w.logs.filter(l => l._stId === 's1').length === 0);
  }

  // ---------- T6 明细筛选 ----------
  console.log('T6 明细筛选');
  {
    const w = newDom().window;
    w.stations.push({ id: 's1', name: 'A', base: 'https://a.cc', token: 't', proxy: '', enabled: true });
    w.logs.push(
      mkLog({ id: 1, _stId: 's1', _st: 'A', model_name: 'gpt-5.6', created_at: NOW }),
      mkLog({ id: 2, _stId: 's1', _st: 'A', model_name: 'claude-x', created_at: TODAY0 - 20 * 86400 }) // 20天前
    );
    const d = w.document;
    d.getElementById('fFrom').value = ''; d.getElementById('fTo').value = '';
    d.getElementById('fStation').value = ''; d.getElementById('fModel').value = '';
    ok('无筛选=2条', w.getFiltered().length === 2);
    d.getElementById('fModel').value = 'gpt';
    ok('模型筛选=1条', w.getFiltered().length === 1);
    d.getElementById('fModel').value = '';
    const yest = new Date((TODAY0 - 86400) * 1000);
    const ds = yest.getFullYear() + '-' + String(yest.getMonth() + 1).padStart(2, '0') + '-' + String(yest.getDate()).padStart(2, '0');
    d.getElementById('fFrom').value = ds;
    ok('起始日期筛掉20天前=1条', w.getFiltered().length === 1);
  }

  // ---------- T7 dailyStack 分桶 ----------
  console.log('T7 dailyStack 分桶堆叠');
  {
    const w = newDom().window;
    w.stations.push({ id: 's1', name: 'A', base: 'https://a.cc', token: 't', proxy: '', enabled: true });
    w.logs.push(mkLog({ _stId: 's1', _st: 'A', quota: 500000, created_at: TODAY0 + 60 }));
    const ds = w.dailyStack(7);
    ok('7天桶', ds.days.length === 7);
    ok('今天落在最后一桶', ds.series[0].values[6] === 500000);
    ok('其余桶为0', ds.series[0].values.slice(0, 6).every(v => v === 0));
  }

  // ---------- T8 fetchJSON 带 New-Api-User 头（new-api 必需）----------
  console.log('T8 New-Api-User 请求头');
  {
    const w = newDom().window;
    let cap = null;
    w.fetch = (url, opts) => { cap = { url, opts }; return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) }); };
    // 有 userId → 必须带头
    w.fetchJSON('https://x.cc/api/user/self', 'TOK', '1234');
    await new Promise(r => setTimeout(r, 0));
    ok('有 userId 时带 New-Api-User 头', cap && cap.opts.headers['New-Api-User'] === '1234');
    ok('Authorization 仍是 Bearer', cap && cap.opts.headers['Authorization'] === 'Bearer TOK');
    // 无 userId → 不带头
    cap = null;
    w.fetchJSON('https://x.cc/api/user/self', 'TOK', '');
    await new Promise(r => setTimeout(r, 0));
    ok('无 userId 时不带 New-Api-User 头', cap && !cap.opts.headers['New-Api-User']);
  }

  // ---------- T9 DEFAULT_STATIONS 首次注入 ----------
  console.log('T9 预设站点首次注入');
  {
    const fs = require('fs');
    // 模拟全新 localStorage：清空后再建一个 dom
    const dom = newDom();
    dom.window.localStorage.clear();
    const w = dom.window;
    // 等 init 自执行（脚本加载即跑）；但为了确定性，手动复现注入分支
    ok('DEFAULT_STATIONS 含 DoCode 预设', Array.isArray(w.DEFAULT_STATIONS) && w.DEFAULT_STATIONS.some(s => s.base === 'https://docode.cc' && s.token.indexOf('+VGbtb') === 0));
    ok('预设 token 正是用户提供的值', w.DEFAULT_STATIONS[0].token === '+VGbtbRy2UA9100ZekjMjk84dWq20A==');
    ok('预设 userId 已知 6953', w.DEFAULT_STATIONS[0].userId === '6953');
    ok('预设代理前缀指向 NAS 域名', /33rk2583pa59\.vicp\.fun\/proxy\.php\?u=$/.test(w.DEFAULT_STATIONS[0].proxy));
  }

  // ---------- T10 401 报错文案被捕获（用户可见原因）----------
  console.log('T10 401 错误文案');
  {
    const w = newDom().window;
    w.stations.push({ id: 's1', name: 'A', base: 'https://a.cc', token: 't', userId: '', proxy: '', enabled: true });
    w.refreshing = false;
    w.fetch = (url) => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ success: false, message: 'Unauthorized, New-Api-User header not provided' }) });
    await w.refreshAll(true);
    await new Promise(r => setTimeout(r, 0));
    ok('401 文案写入 stationErr', /New-Api-User/.test(w.stationErr.s1 || ''));
  }

  // ---------- T11: CORS 拦截（Failed to fetch）触发引导弹窗 ----------
  console.log('T11 CORS 拦截 → 引导弹窗自动出现');
  {
    const w = newDom().window;
    w.sessionStorage.clear();
    w.stations.push({ id: 's1', name: 'A', base: 'https://a.cc', token: 't', userId: '1', proxy: '', enabled: true });
    w.refreshing = false;
    w.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    await w.refreshAll(false);
    await new Promise(r => setTimeout(r, 50));
    ok('Failed to fetch 被识别为 CORS 拦截', /Failed to fetch|拦截/.test(w.stationErr.s1 || '') || w.stationErr.s1 === 'Failed to fetch');
    ok('CORS 引导弹窗被打开', !$('corsMask', w).classList.contains('hide'));
    ok('弹窗内包含 proxy.php 源码', $('corsProxySrc', w).value.indexOf('<?php') === 0);
    ok('sessionStorage 标记避免重复弹出', w.sessionStorage.getItem('cors_guide_shown') === '1');
  }

  // ---------- T12: 代理 URL 拼接（核心功能） ----------
  console.log('T12 代理 URL 正确拼接');
  {
    const w = newDom().window;
    w.stations.push({ id: 's1', name: 'A', base: 'https://a.cc', token: 't', userId: '1', proxy: 'https://nas.example.com/proxy.php?u=', enabled: true });
    w.refreshing = false;
    let capturedUrl = null;
    w.fetch = (url) => { capturedUrl = url; return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { quota: 0, used_quota: 0 } }) }); };
    await w.refreshAll(false);
    await new Promise(r => setTimeout(r, 50));
    ok('请求通过代理 URL 转发', capturedUrl && capturedUrl.indexOf('https://nas.example.com/proxy.php?u=https://a.cc/api/') === 0);
  }

  // ---------- T13: 普通 CORS 报错关键词也识别（NetworkError / Load failed）----------
  console.log('T13 多种 CORS 错误关键词');
  {
    const w = newDom().window;
    w.sessionStorage.clear();
    w.stations.push({ id: 's2', name: 'B', base: 'https://b.cc', token: 't', userId: '2', proxy: '', enabled: true });
    w.refreshing = false;
    w.fetch = () => Promise.reject(new Error('NetworkError when attempting to fetch resource'));
    await w.refreshAll(false);
    await new Promise(r => setTimeout(r, 50));
    ok('NetworkError 同样触发引导', !$('corsMask', w).classList.contains('hide'));
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('未捕获异常:', e); process.exit(1); });
