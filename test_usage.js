/* relay-usage 看板 jsdom 测试：聚合数学 + 站点管理 + 容错 */
const fs = require('fs');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync('C:/Users/Administrator/WorkBuddy/20260428222742/relay-usage/index.html', 'utf8');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}
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
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'https://example.com/' });
  dom.window.AbortSignal = AbortSignal;
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

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('未捕获异常:', e); process.exit(1); });
