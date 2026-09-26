// Settings window: serial connection + the overlay's appearance settings,
// with a live preview rendered by the same HUD module the overlay uses.
(function(){
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const H = window.MixerHud;
  const $ = id => document.getElementById(id);

  let A = H.normalize(null);
  let state = null;

  /* ================= connection ================= */
  async function refreshPorts(prefer){
    let ports = [];
    try { ports = await invoke('get_serial_ports'); } catch (e) {}
    const sel = $('portSelect'); sel.innerHTML = '';
    if (!ports.length){
      const o = document.createElement('option'); o.textContent = 'No serial ports found'; o.disabled = true; o.selected = true; sel.appendChild(o);
      return;
    }
    ports.forEach(p => { const o = document.createElement('option'); o.value = p; o.textContent = p; sel.appendChild(o); });
    if (prefer && ports.includes(prefer)) sel.value = prefer;
  }
  $('refreshPorts').addEventListener('click', () => refreshPorts($('portSelect').value));
  $('connectBtn').addEventListener('click', async () => {
    const port = $('portSelect').value; if (!port) return;
    $('portHint').textContent = 'Connecting to ' + port + '…';
    try { await invoke('connect_serial_port', { port }); $('portHint').textContent = 'Connected to ' + port + '. It will open automatically next launch.'; }
    catch (e) {
      // the backend's message already names the port ("couldn't open COM5: ...")
      const msg = String(e).replace(/\.$/, '');
      $('portHint').textContent = msg.charAt(0).toUpperCase() + msg.slice(1) + '. Check the Nano is plugged in and no other app (like the Arduino IDE serial monitor) has the port open.';
    }
  });
  function renderConn(connected){
    const c = $('connState');
    c.textContent = connected ? 'CONNECTED' : 'NOT CONNECTED';
    c.className = 'conn ' + (connected ? 'ok' : 'bad');
  }

  /* ================= preview ================= */
  const preview = H.create($('previewHud'), { hint: 'click close · hold: normal → mute → solo' });
  // the rim bends the sample scene exactly like the overlay bends the live game
  function feedRim(){ const r = desk.getBoundingClientRect(); preview.setRimSource(scene, { x: r.left, y: r.top, w: r.width, h: r.height }); }
  const desk = $('desk'), scene = $('scene');

  function drawScene(){
    const t = H.themeOf(A), dpr = Math.min(window.devicePixelRatio || 1, 2), w = desk.clientWidth, h = desk.clientHeight;
    scene.width = w * dpr; scene.height = h * dpr;
    const g = scene.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sky = g.createLinearGradient(0, 0, 0, h * .62);
    sky.addColorStop(0, t.sky[0]); sky.addColorStop(.55, t.sky[1]); sky.addColorStop(1, t.sky[2]);
    g.fillStyle = sky; g.fillRect(0, 0, w, h * .62);
    let seed = 7; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    g.fillStyle = 'rgba(255,255,255,.7)';
    for (let i = 0; i < 90; i++) g.fillRect(rnd() * w, rnd() * h * .42, rnd() < .15 ? 2 : 1, rnd() < .15 ? 2 : 1);
    g.fillStyle = 'rgba(255,236,190,.9)'; g.beginPath(); g.arc(w * .76, h * .5, Math.min(w, h) * .09, 0, Math.PI * 2); g.fill();
    const ridge = (base, amp, c) => { g.fillStyle = c; g.beginPath(); g.moveTo(0, h); for (let x = 0; x <= w; x += w / 14) g.lineTo(x, h * base - rnd() * amp); g.lineTo(w, h); g.fill(); };
    ridge(.58, h * .14, 'rgba(20,10,35,.75)'); ridge(.62, h * .08, 'rgba(12,6,22,.9)');
    const fy = h * .62; g.fillStyle = '#0c0916'; g.fillRect(0, fy, w, h - fy);
    g.strokeStyle = 'rgb(' + H.accentRgb(A) + ' / .45)'; g.lineWidth = 1;
    for (let k = 0; k < 14; k++){ const y = fy + Math.pow(k / 13, 1.8) * (h - fy); g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    for (let v = -12; v <= 12; v++){ g.beginPath(); g.moveTo(w / 2 + v * 14, fy); g.lineTo(w / 2 + v * w * .12, h); g.stroke(); }
    g.font = '600 12px "Geist Mono",monospace'; g.fillStyle = 'rgba(255,255,255,.85)';
    g.fillText('HP 86', 18, h - 44); g.fillText('30 / 120', w - 86, h - 44);
    g.strokeStyle = 'rgba(255,255,255,.8)'; g.lineWidth = 1.5; g.strokeRect(w - 88, 18, 70, 70);
    g.beginPath(); g.arc(w / 2, h * .82, 7, 0, Math.PI * 2); g.stroke();
  }
  function fitPreview(){
    const host = $('previewHud'); host.style.transform = '';
    const need = preview.panel.offsetWidth, room = desk.clientWidth - 24;
    host.style.transform = need > room ? 'scale(' + (room / need).toFixed(3) + ')' : '';
  }
  function showState(p){
    state = p;
    // the preview always shows the open panel, whatever the overlay is doing
    preview.setState(Object.assign({}, p, { expanded: true }));
    renderConn(p.connected);
    $('deskCap').innerHTML = '<b>BANK ' + (p.bank + 1) + '</b> · overlay is ' + (p.expanded ? 'open' : 'closed') + ' · live';
    buildAppColors();
  }

  /* ================= settings controls ================= */
  const SLIDERS = ['bgA', 'bgBlur', 'chroma', 'shine', 'shineSpin', 'rimHot', 'tint', 'tintDark', 'shade', 'halo', 'iconTint', 'rim', 'radius', 'rimW', 'refract', 'blur', 'glint', 'speed', 'mspeed', 'bounce', 'stretch', 'meterMs'];
  const FMT = { bgA: v => v + '%', bgBlur: v => v ? v + 'px' : 'off', chroma: v => v + '%', shine: v => v + '%', shineSpin: v => v ? v + '%' : 'still', rimHot: v => v + '%', tintDark: v => v + '%', shade: v => v + '%', halo: v => v + '%', tint: v => v + '%', iconTint: v => v + '%', rim: v => v + '%', radius: v => v + 'px', rimW: v => v + 'px',
    refract: v => v || 'off', blur: v => v + 'px', glint: v => v + '%', speed: v => (+v).toFixed(1) + 's',
    mspeed: v => (+v).toFixed(2) + '×', bounce: v => v + '%', stretch: v => v + '%', meterMs: v => v + 'ms' };

  H.THEMES.forEach(t => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'opt'; b.dataset.v = t.id; b.setAttribute('role', 'radio');
    b.innerHTML = '<span class="sw" style="background:linear-gradient(135deg,' + t.sky[0] + ',' + t.sky[1] + ' 60%,' + t.sky[2] + ')"><i style="background:rgb(' + t.acc + ');box-shadow:0 0 8px rgb(' + t.acc + ')"></i></span><span class="lbl">' + t.name + '</span>';
    b.addEventListener('click', () => { A.theme = t.id; A.accent = null; changed(true); });
    $('themes').appendChild(b);
  });
  H.STYLES.forEach(s => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'opt'; b.dataset.v = s.id; b.setAttribute('role', 'radio');
    b.innerHTML = '<span class="glyph g-' + s.id + '"><b></b><b class="on"></b><b></b></span><span class="lbl">' + s.name + '</span>';
    b.addEventListener('click', () => { A.style = s.id; changed(); });
    $('styles').appendChild(b);
  });
  (function fontPreviews(){
    const fams = H.FONTS.filter(f => !f.sys && f.n !== 'Geist').map(f => 'family=' + f.n.replace(/ /g, '+') + ':wght@500;600').join('&');
    const chars = Array.from(new Set((H.FONTS.map(f => f.n).join('') + 'MUTE').split(''))).join('');
    const l = document.createElement('link'); l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?' + fams + '&text=' + encodeURIComponent(chars) + '&display=swap';
    document.head.appendChild(l);
  })();
  H.FONTS.forEach(f => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'fontOpt'; b.dataset.v = f.n; b.setAttribute('role', 'radio');
    const fam = H.fontCss(f).replace(/"/g, "'");
    b.innerHTML = '<span class="fn" style="font-family:' + fam + '">' + f.n + '</span><span class="fs" style="font-family:' + fam + '">Mute</span>';
    b.addEventListener('click', () => { A.font = f.n; changed(); });
    $('fonts').appendChild(b);
  });
  document.querySelectorAll('.seg[data-k]').forEach(g => g.querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => {
      const t = g.dataset.type, v = b.dataset.v;
      A[g.dataset.k] = t === 'bool' ? v === 'true' : t === 'num' ? Number(v) : v;
      changed();
    })));
  SLIDERS.forEach(k => $(k).addEventListener('input', function(){ A[k] = parseFloat(this.value); changed(); }));
  $('accentPick').addEventListener('input', function(){ A.accent = this.value; changed(true); });
  $('accentReset').addEventListener('click', () => { A.accent = null; changed(true); });
  $('mutePick').addEventListener('input', function(){ A.mute = this.value; changed(); });
  $('muteReset').addEventListener('click', () => { A.mute = null; changed(); });
  $('bgPick').addEventListener('input', function(){ A.bg = this.value; if (!A.bgA) A.bgA = 60; changed(); });
  $('bgReset').addEventListener('click', () => { A.bg = '#000000'; changed(); });
  $('sysOverride').addEventListener('click', () => { A.ignoreSysMotion = !A.ignoreSysMotion; changed(); });
  $('resetBtn').addEventListener('click', () => { A = H.normalize(null); changed(true); });

  /* ---- tabs: one short page per topic instead of one long scroll ---- */
  const tabs = document.querySelectorAll('.tabs [role=tab]');
  function showTab(id){
    tabs.forEach(t => { const on = t.dataset.tab === id; t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1; });
    document.querySelectorAll('.pane').forEach(p => { p.hidden = p.dataset.pane !== id; });
    document.querySelector('.settings').scrollTop = 0;
    try { localStorage.setItem('settingsTab', id); } catch (e) {}
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => showTab(t.dataset.tab));
    t.addEventListener('keydown', e => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      const n = tabs[(i + d + tabs.length) % tabs.length]; n.focus(); showTab(n.dataset.tab);
    });
  });
  let firstTab = 'look';
  try { firstTab = localStorage.getItem('settingsTab') || firstTab; } catch (e) {}
  showTab(document.querySelector('.pane[data-pane="' + firstTab + '"]') ? firstTab : 'look');

  /* ---- long explanations become hover tips so the lists stay short ---- */
  document.querySelectorAll('.field .help').forEach(h => {
    const f = h.closest('.field'), lbl = f.querySelector('label');
    f.title = h.textContent; lbl.classList.add('hasTip'); h.remove();
  });

  /* ---- visibility presets ---- */
  const PRESETS = {
    clear:    { bgA: 0,  bgBlur: 0,  shade: 25, halo: 40, tint: 30, tintDark: 0 },
    balanced: { bgA: 25, bgBlur: 14, shade: 40, halo: 55, tint: 36, tintDark: 20, liveGlass: true },
    solid:    { bgA: 80, bgBlur: 20, shade: 60, halo: 70, tint: 50, tintDark: 40, liveGlass: true },
  };
  document.querySelectorAll('.preset').forEach(b => b.addEventListener('click', () => { Object.assign(A, PRESETS[b.dataset.preset]); changed(); }));
  function syncPresets(){
    document.querySelectorAll('.preset').forEach(b => {
      const p = PRESETS[b.dataset.preset];
      b.setAttribute('aria-pressed', Object.keys(p).every(k => A[k] === p[k]));
    });
  }
  if (window.matchMedia) matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => syncControls());

  /* ---- per-app colors, keyed by app so they apply in every bank ---- */
  let appsKey = '';
  function assignedApps(){
    const map = new Map();
    if (!state) return [];
    state.banks.forEach((bank, b) => bank.forEach((ch, c) => {
      if (!ch.app_id) return;
      if (!map.has(ch.app_id)) map.set(ch.app_id, { id: ch.app_id, name: ch.app_name || ch.app_id, spots: [] });
      map.get(ch.app_id).spots.push('B' + (b + 1) + '·' + (c + 1));
    }));
    return Array.from(map.values());
  }
  function buildAppColors(){
    const apps = assignedApps(), key = apps.map(a => a.id + a.spots.join()).join('|');
    if (key === appsKey) { refreshAppColors(); return; }
    appsKey = key;
    const box = $('appColors'); box.innerHTML = '';
    if (!apps.length){ box.innerHTML = '<div class="none">No apps assigned yet. Open the overlay and click a channel\'s name to assign one.</div>'; return; }
    apps.forEach(app => {
      const r = document.createElement('div'); r.className = 'appRow'; r.dataset.app = app.id;
      r.innerHTML = '<span class="miniTile"></span><span class="appName"></span>' +
        '<label class="pick">TILE<input type="color"></label><label class="pick">HIGHLIGHT<input type="color"></label>' +
        '<button class="mini" type="button">Reset</button>';
      r.querySelector('.appName').innerHTML = '';
      r.querySelector('.appName').append(document.createTextNode(app.name));
      const small = document.createElement('small'); small.textContent = app.spots.join('  '); r.querySelector('.appName').append(small);
      const ins = r.querySelectorAll('input');
      ins[0].setAttribute('aria-label', app.name + ' tile color'); ins[1].setAttribute('aria-label', app.name + ' highlight color');
      ins[0].addEventListener('input', function(){ A.appColors[app.id] = Object.assign({}, A.appColors[app.id], { tile: this.value }); changed(); });
      ins[1].addEventListener('input', function(){ A.appColors[app.id] = Object.assign({}, A.appColors[app.id], { hl: this.value }); changed(); });
      r.querySelector('button').addEventListener('click', () => { delete A.appColors[app.id]; changed(); });
      box.appendChild(r);
    });
    refreshAppColors();
  }
  function refreshAppColors(){
    const sel = state && state.banks[state.bank][state.channel];
    document.querySelectorAll('#appColors .appRow').forEach(r => {
      const id = r.dataset.app, t = H.tileFor(id, A), tc = H.rgbStr(t.tc), ta = A.iconTint / 100;
      const name = r.querySelector('.appName').firstChild.textContent;
      const mt = r.querySelector('.miniTile');
      mt.textContent = name.trim().charAt(0).toUpperCase(); mt.style.color = t.fg;
      mt.style.background = 'linear-gradient(160deg,rgb(' + tc + ' / ' + ta + '),rgb(' + tc + ' / ' + (ta * .42).toFixed(3) + '))';
      mt.style.boxShadow = 'inset 0 1px 0 rgba(255,255,255,.28),inset 0 0 0 1px rgb(' + tc + ' / .6)';
      const ins = r.querySelectorAll('input');
      if (document.activeElement !== ins[0]) ins[0].value = t.base;
      if (document.activeElement !== ins[1]) ins[1].value = (A.appColors[id] && A.appColors[id].hl) || H.accentHex(A);
      r.querySelector('button').disabled = !A.appColors[id];
      r.classList.toggle('active', !!sel && sel.app_id === id);
    });
  }

  function syncControls(){
    const t = H.themeOf(A);
    document.documentElement.style.setProperty('--accent', 'rgb(' + H.accentRgb(A) + ')');
    $('themeName').textContent = t.name;
    $('styleName').textContent = H.STYLES.filter(s => s.id === A.style)[0].name;
    $('fontName').textContent = A.font;
    $('motionName').textContent = A.motion.charAt(0).toUpperCase() + A.motion.slice(1);
    document.querySelectorAll('#themes .opt').forEach(o => o.setAttribute('aria-checked', o.dataset.v === A.theme));
    document.querySelectorAll('#styles .opt').forEach(o => o.setAttribute('aria-checked', o.dataset.v === A.style));
    document.querySelectorAll('#fonts .fontOpt').forEach(o => o.setAttribute('aria-checked', o.dataset.v === A.font));
    document.querySelectorAll('.seg[data-k]').forEach(g => g.querySelectorAll('button').forEach(o => o.setAttribute('aria-checked', o.dataset.v === String(A[g.dataset.k]))));
    $('liveName').textContent = A.liveGlass ? A.captureFps + ' fps · ' + ({2: 'sharp', 3: 'balanced', 4: 'fastest'}[A.captureScale] || '') : 'off';
    SLIDERS.forEach(k => { if (document.activeElement !== $(k)) $(k).value = A[k]; $(k + 'Out').textContent = FMT[k](A[k]); });
    if (document.activeElement !== $('accentPick')) $('accentPick').value = H.accentHex(A);
    if (document.activeElement !== $('mutePick')) $('mutePick').value = A.mute || H.MUTE_DEFAULT;
    $('accentReset').disabled = !A.accent; $('muteReset').disabled = !A.mute;
    if (document.activeElement !== $('bgPick')) $('bgPick').value = A.bg || '#000000';
    $('bgReset').disabled = !A.bg || A.bg.toLowerCase() === '#000000';
    const sys = H.isSystemReduced();
    $('sysNote').hidden = !sys;
    $('sysNoteTxt').textContent = A.ignoreSysMotion ? 'Animating even though Windows has animation effects turned off.' : 'Windows has animation effects turned off, so the overlay is holding still.';
    $('sysOverride').textContent = A.ignoreSysMotion ? 'Follow Windows' : 'Animate anyway';
    refreshAppColors();
    syncPresets();
  }

  let saveTimer = 0, lastSave = 0;
  function save(){
    const run = () => { lastSave = performance.now(); invoke('set_appearance', { appearance: A }).catch(() => {}); };
    clearTimeout(saveTimer);
    const wait = 60 - (performance.now() - lastSave);
    if (wait <= 0) run(); else saveTimer = setTimeout(run, wait);
  }
  function changed(sceneToo){
    preview.setAppearance(A);
    syncControls();
    if (sceneToo) drawScene();
    fitPreview();
    feedRim();
    save();
  }

  /* ================= boot ================= */
  function layout(){ drawScene(); fitPreview(); feedRim(); }
  if (window.ResizeObserver) new ResizeObserver(layout).observe(desk);

  (async function boot(){
    try { A = H.normalize(await invoke('get_appearance')); } catch (e) {}
    preview.setAppearance(A);
    syncControls(); layout();
    let cfg = null;
    try { cfg = await invoke('get_config'); } catch (e) {}
    await refreshPorts(cfg && cfg.last_port);
    try { showState(await invoke('get_state')); } catch (e) {}
    fitPreview(); feedRim();
    if (document.fonts) document.fonts.ready.then(() => { fitPreview(); feedRim(); });
  })();
  listen('overlay-state', e => showState(e.payload));
})();
