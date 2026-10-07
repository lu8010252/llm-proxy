/* 三个页面共用的外观:主题(日出日落 / 按时间 / 浅色 / 深色)、背景配色、主题色、卡片透明度。
   设置只保存在当前浏览器(localStorage)。配置页「外观」标签里调整,首页/日志页自动跟随。 */
(function () {
  var KEY = 'llmproxy_ap', OLD = 'llmproxy_theme';
  var DEF = { mode: 'auto', from: '06:00', to: '18:00', geo: '32.97,117.19', bg: 'classic', ac: 'default', glass: 0 };
  var LAB = { sun: ['🌅', '日出日落'], auto: ['🕒', '按时间'], light: ['☀️', '浅色'], dark: ['🌙', '深色'] };
  /* 背景配色:[名称, 浅色三团, 深色三团];classic = 原来的样子 */
  var PAL = {
    classic: ['原样'],
    sky: ['晴空', ['rgba(34,211,238,.5)', 'rgba(244,114,182,.42)', 'rgba(129,140,248,.5)'], ['rgba(13,148,136,.5)', 'rgba(147,51,234,.42)', 'rgba(37,99,235,.5)']],
    aurora: ['极光', ['rgba(52,211,153,.5)', 'rgba(96,165,250,.45)', 'rgba(167,139,250,.45)'], ['rgba(5,150,105,.5)', 'rgba(37,99,235,.45)', 'rgba(109,40,217,.42)']],
    sunset: ['晚霞', ['rgba(251,146,60,.45)', 'rgba(244,114,182,.45)', 'rgba(167,139,250,.42)'], ['rgba(194,65,12,.5)', 'rgba(190,24,93,.45)', 'rgba(91,33,182,.42)']],
    sakura: ['樱花', ['rgba(249,168,212,.55)', 'rgba(253,186,116,.4)', 'rgba(216,180,254,.45)'], ['rgba(157,23,77,.5)', 'rgba(180,83,9,.38)', 'rgba(107,33,168,.42)']],
    ocean: ['海洋', ['rgba(56,189,248,.5)', 'rgba(45,212,191,.42)', 'rgba(129,140,248,.45)'], ['rgba(3,105,161,.55)', 'rgba(15,118,110,.45)', 'rgba(67,56,202,.45)']],
    lavender: ['薰衣草', ['rgba(196,181,253,.55)', 'rgba(244,168,220,.45)', 'rgba(147,197,253,.45)'], ['rgba(91,33,182,.5)', 'rgba(157,23,109,.42)', 'rgba(30,64,175,.45)']],
    graphite: ['石墨', ['rgba(148,163,184,.4)', 'rgba(203,213,225,.45)', 'rgba(148,163,184,.3)'], ['rgba(71,85,105,.5)', 'rgba(51,65,85,.5)', 'rgba(100,116,139,.35)']],
    plain: ['纯色', ['transparent', 'transparent', 'transparent'], ['transparent', 'transparent', 'transparent']]
  };
  /* 主题色:[名称, 浅色下 [主色, 辅色], 深色下 [主色, 辅色]] */
  var ACC = {
    'default': ['原样'],
    blue: ['蓝', ['#2563eb', '#06b6d4'], ['#6ea8ff', '#22d3ee']],
    green: ['绿', ['#059669', '#0ea5e9'], ['#34d399', '#38bdf8']],
    purple: ['紫', ['#7c3aed', '#db2777'], ['#a78bfa', '#f472b6']],
    orange: ['橙', ['#ea580c', '#db2777'], ['#fb923c', '#f472b6']],
    rose: ['玫红', ['#be185d', '#7c3aed'], ['#f472b6', '#a78bfa']]
  };

  var AP = {}, ui = null, k;
  function load() {
    for (k in DEF) AP[k] = DEF[k];
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (s) { for (k in s) AP[k] = s[k]; }
      else { var o = localStorage.getItem(OLD); if (o === 'light' || o === 'dark') AP.mode = o; } /* 兼容旧版的单一开关 */
    } catch (e) {}
    if (!LAB[AP.mode]) AP.mode = 'auto';
    if (!PAL[AP.bg]) AP.bg = 'classic';
    if (!ACC[AP.ac]) AP.ac = 'default';
    AP.glass = Math.max(0, Math.min(80, +AP.glass || 0));
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(AP)); } catch (e) {} apply(); }

  /* ---- 日出日落:按经纬度在浏览器里直接算,不联网 ---- */
  function sunTimes(lat, lon, date) {
    var R = Math.PI / 180, DAY = 864e5, J1970 = 2440588, J2000 = 2451545, E = R * 23.4397, J0 = .0009;
    var lw = R * -lon, phi = R * lat, d = date.valueOf() / DAY - .5 + J1970 - J2000;
    var n = Math.round(d - J0 - lw / (2 * Math.PI)), ds = J0 + lw / (2 * Math.PI) + n;
    var M = R * (357.5291 + .98560028 * ds), C = R * (1.9148 * Math.sin(M) + .02 * Math.sin(2 * M) + .0003 * Math.sin(3 * M));
    var L = M + C + R * 102.9372 + Math.PI, dec = Math.asin(Math.sin(E) * Math.sin(L));
    var Jn = J2000 + ds + .0053 * Math.sin(M) - .0069 * Math.sin(2 * L);
    var w = Math.acos((Math.sin(R * -.833) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));
    if (!isFinite(w)) return null;
    var a = J0 + (w + lw) / (2 * Math.PI) + n, Js = J2000 + a + .0053 * Math.sin(M) - .0069 * Math.sin(2 * L);
    function from(j) { return new Date((j + .5 - J1970) * DAY); }
    return { rise: from(Jn - (Js - Jn)), set: from(Js) };
  }
  function geo() {
    var m = String(AP.geo || '').replace(/[，;；\s]+/g, ',').split(',').map(Number);
    return m.length === 2 && m.every(isFinite) && Math.abs(m[0]) <= 90 && Math.abs(m[1]) <= 180 ? { lat: m[0], lon: m[1] } : null;
  }
  function sunToday() {
    var g = geo(); if (!g) return null;
    var n = new Date(), t = sunTimes(g.lat, g.lon, new Date(n.getFullYear(), n.getMonth(), n.getDate(), 12));
    return t && isFinite(t.rise) && isFinite(t.set) ? t : null;
  }
  function tm(s) { var p = String(s).split(':'); return (+p[0] || 0) * 60 + (+p[1] || 0); }
  function isDark() {
    if (AP.mode === 'dark') return true;
    if (AP.mode === 'light') return false;
    var n = new Date();
    if (AP.mode === 'sun') { var t = sunToday(); if (t) return n < t.rise || n > t.set; }
    var m = n.getHours() * 60 + n.getMinutes(), l = tm(AP.from), d = tm(AP.to);   /* 浅色从 from 开始,深色从 to 开始,可跨午夜 */
    return d === l ? false : l < d ? (m >= d || m < l) : (m >= d && m < l);
  }

  /* ---- 应用到页面 ---- */
  var css = document.createElement('style');
  css.id = 'ap-css';
  css.textContent =
    'html[data-bg] body{background:radial-gradient(60vw 60vw at 8% 0%,var(--ap1),transparent 70%),radial-gradient(55vw 55vw at 96% 20%,var(--ap2),transparent 70%),radial-gradient(60vw 60vw at 52% 108%,var(--ap3),transparent 72%),var(--bg)!important;background-attachment:fixed!important}' +
    'html[data-glass] .topnav,html[data-glass] .card,html[data-glass] .kpi,html[data-glass] .savebar,html[data-glass] #detail{background:color-mix(in srgb,var(--surface) var(--ap-s),transparent)!important;-webkit-backdrop-filter:blur(16px) saturate(160%);backdrop-filter:blur(16px) saturate(160%)}' +
    '.apx{display:flex;flex-direction:column;gap:16px}.apx-r{display:grid;grid-template-columns:130px minmax(0,1fr);gap:6px 14px;align-items:start}' +
    '.apx-r>label{color:var(--text-dim);font-size:13px;padding-top:7px}.apx .small{margin-top:6px}' +
    '.apx input[type=time]{width:auto}.apx .inl{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.apx .inl input[type=text]{flex:1;min-width:140px}' +
    '.apx-sw{display:flex;flex-wrap:wrap;gap:10px}' +
    '.apx button.sw{width:72px;height:48px;padding:0;border-radius:10px;border:2px solid var(--border);position:relative;overflow:hidden;background:var(--surface)}' +
    '.apx button.sw.on,.apx button.sw:hover{border-color:var(--accent)}' +
    '.apx button.sw span{position:absolute;left:0;right:0;bottom:0;font-size:11px;line-height:17px;background:rgba(0,0,0,.38);color:#fff}' +
    '.apx button.sw.dot{width:38px;height:38px;border-radius:50%}' +
    '.apx .rg{display:flex;align-items:center;gap:12px}.apx .rg input{flex:1;padding:0}.apx .rg output{width:44px;text-align:right;color:var(--text-dim);font-size:13px}' +
    '@media(max-width:640px){.apx-r{grid-template-columns:1fr}.apx-r>label{padding-top:0}}';
  (document.head || document.documentElement).appendChild(css);

  function setv(n, v) { document.documentElement.style.setProperty(n, v); }
  function rmv(n) { document.documentElement.style.removeProperty(n); }
  function paintBtn() {
    var b = document.getElementById('themeBtn'); if (!b) return;
    var l = LAB[AP.mode], auto = AP.mode === 'sun' || AP.mode === 'auto';
    if (b.classList.contains('theme-btn')) b.innerHTML = '<span>' + l[0] + '</span><span class="tb-tx"> ' + l[1] + '</span>';
    else b.textContent = l[0] + ' ' + l[1];
    b.title = '外观:' + l[1] + (auto ? '(现在是' + (isDark() ? '深色' : '浅色') + ')' : '') + ',点击切换';
  }
  function apply() {
    var r = document.documentElement, d = isDark();
    r.setAttribute('data-theme', d ? 'dark' : 'light');
    var P = PAL[AP.bg];
    if (AP.bg === 'classic') { r.removeAttribute('data-bg'); rmv('--ap1'); rmv('--ap2'); rmv('--ap3'); }
    else { var c = P[d ? 2 : 1]; setv('--ap1', c[0]); setv('--ap2', c[1]); setv('--ap3', c[2]); r.setAttribute('data-bg', '1'); }
    var A = ACC[AP.ac];
    if (AP.ac === 'default') { rmv('--accent'); rmv('--accent2'); rmv('--on-accent'); }
    else { var v = A[d ? 2 : 1]; setv('--accent', v[0]); setv('--accent2', v[1]); setv('--on-accent', d ? '#0a0a12' : '#ffffff'); }
    if (AP.glass > 0) { r.setAttribute('data-glass', '1'); setv('--ap-s', (100 - AP.glass) + '%'); }
    else { r.removeAttribute('data-glass'); rmv('--ap-s'); }
    paintBtn();
    if (ui) ui.refresh();
  }
  /* 右上角按钮:自动 → 跟当前相反的固定色 → 另一个固定色 → 回到自动 */
  function cycle() {
    var m = AP.mode;
    if (m === 'sun' || m === 'auto') { AP.am = m; AP.mode = isDark() ? 'light' : 'dark'; AP.step = 1; }
    else if (AP.step === 1) { AP.mode = m === 'dark' ? 'light' : 'dark'; AP.step = 2; }
    else { AP.mode = (AP.am === 'sun' || AP.am === 'auto') ? AP.am : 'auto'; AP.step = 0; }
    save();
  }

  /* ---- 配置页「外观」标签里的设置界面 ---- */
  function render(el) {
    var opt = Object.keys(LAB).map(function (m) {
      return '<option value="' + m + '">' + { sun: '日出日落(白天浅色、夜里深色)', auto: '按时间(自己定几点切换)', light: '始终浅色', dark: '始终深色' }[m] + '</option>';
    }).join('');
    el.innerHTML =
      '<div class="apx">' +
      '<div class="apx-r"><label>主题</label><div><select id="apx_mode">' + opt + '</select></div></div>' +
      '<div class="apx-r" id="apx_geo_r"><label>位置</label><div><div class="inl"><input type="text" id="apx_geo" placeholder="纬度,经度  例如 32.97,117.19" autocomplete="off"><button type="button" id="apx_loc">定位</button></div><div class="small" id="apx_sun"></div></div></div>' +
      '<div class="apx-r" id="apx_time_r"><label>切换时间</label><div class="inl"><input type="time" id="apx_from"> 起浅色 · <input type="time" id="apx_to"> 起深色</div></div>' +
      '<div class="apx-r"><label>背景配色</label><div class="apx-sw" id="apx_bg"></div></div>' +
      '<div class="apx-r"><label>主题色</label><div class="apx-sw" id="apx_ac"></div></div>' +
      '<div class="apx-r"><label>卡片透明度</label><div><div class="rg"><input type="range" id="apx_glass" min="0" max="80" step="1"><output id="apx_gv"></output></div><div class="small">0 = 原来的实心卡片;调高会变成毛玻璃,配合上面的背景配色更好看</div></div></div>' +
      '<div class="apx-r"><label></label><div class="inl"><button type="button" id="apx_reset">恢复默认</button><span class="small" style="margin:0">以上设置即时生效,只保存在当前浏览器</span></div></div>' +
      '</div>';
    function q(id) { return el.querySelector('#' + id); }
    function sw() {
      var d = isDark();
      q('apx_bg').innerHTML = Object.keys(PAL).map(function (key) {
        var p = PAL[key], c = key === 'classic' ? null : p[d ? 2 : 1];
        var bg = c ? 'radial-gradient(circle at 15% 20%,' + c[0] + ',transparent 68%),radial-gradient(circle at 88% 30%,' + c[1] + ',transparent 68%),radial-gradient(circle at 50% 105%,' + c[2] + ',transparent 72%),var(--surface)' : 'var(--bg)';
        return '<button type="button" class="sw' + (AP.bg === key ? ' on' : '') + '" data-bg="' + key + '" style="background:' + bg + '" title="' + p[0] + '"><span>' + p[0] + '</span></button>';
      }).join('');
      q('apx_ac').innerHTML = Object.keys(ACC).map(function (key) {
        var a = ACC[key], v = key === 'default' ? null : a[d ? 2 : 1];
        var bg = v ? 'linear-gradient(135deg,' + v[0] + ',' + v[1] + ')' : 'linear-gradient(135deg,var(--accent),var(--accent2))';
        return '<button type="button" class="sw dot' + (AP.ac === key ? ' on' : '') + '" data-ac="' + key + '" style="background:' + bg + '" title="' + a[0] + '" aria-label="' + a[0] + '"></button>';
      }).join('');
    }
    function f2(d) { return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
    function refresh() {
      q('apx_mode').value = AP.mode;
      q('apx_geo').value = AP.geo || ''; q('apx_from').value = AP.from; q('apx_to').value = AP.to;
      q('apx_glass').value = AP.glass; q('apx_gv').textContent = AP.glass + '%';
      q('apx_geo_r').style.display = AP.mode === 'sun' ? '' : 'none';
      var t = sunToday(), noGeo = AP.mode === 'sun' && !t;
      q('apx_time_r').style.display = (AP.mode === 'auto' || noGeo) ? '' : 'none';
      q('apx_sun').textContent = t ? '今天日出 ' + f2(t.rise) + ',日落 ' + f2(t.set) : (AP.geo ? '位置格式不对(或当地今天没有日出日落),暂按下面的时间切换' : '没有填位置,暂按下面的时间切换');
      sw();
    }
    ui = { refresh: refresh };
    q('apx_mode').onchange = function () { AP.mode = this.value; if (AP.mode === 'sun' || AP.mode === 'auto') { AP.am = AP.mode; AP.step = 0; } save(); };
    q('apx_geo').oninput = function () { AP.geo = this.value.trim(); save(); };
    q('apx_from').onchange = function () { AP.from = this.value || DEF.from; save(); };
    q('apx_to').onchange = function () { AP.to = this.value || DEF.to; save(); };
    q('apx_glass').oninput = function () { AP.glass = +this.value; save(); };
    q('apx_bg').onclick = function (e) { var b = e.target.closest('[data-bg]'); if (b) { AP.bg = b.dataset.bg; save(); } };
    q('apx_ac').onclick = function (e) { var b = e.target.closest('[data-ac]'); if (b) { AP.ac = b.dataset.ac; save(); } };
    q('apx_reset').onclick = function () { AP.bg = DEF.bg; AP.ac = DEF.ac; AP.glass = DEF.glass; save(); };
    q('apx_loc').onclick = function () {
      if (!navigator.geolocation || !window.isSecureContext) return alert('浏览器只在 https 或 localhost 下允许定位,请手动填经纬度');
      navigator.geolocation.getCurrentPosition(function (p) { AP.geo = p.coords.latitude.toFixed(2) + ',' + p.coords.longitude.toFixed(2); save(); }, function () { alert('定位失败,请手动填经纬度'); }, { timeout: 8000 });
    };
    refresh();
  }

  load(); apply();
  window.applyTheme = apply;
  window.cycleTheme = cycle;
  window.renderAppearance = render;
  document.addEventListener('DOMContentLoaded', paintBtn);
  setInterval(apply, 60000);
  window.addEventListener('storage', function (e) { if (e.key === KEY || e.key === OLD) { load(); apply(); } });
})();
