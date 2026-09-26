// Overlay window: renders the shared HUD from backend state. Navigation,
// mute/solo, and open/close all come from the Nano via the Rust backend;
// the only mouse interaction here is assigning an app to a channel.
(function(){
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  const hud = MixerHud.create(document.getElementById('stage'), {
    onPick: openMenu,
  });

  let appearance = null;

  // ---- app-assignment menu ----
  let menu = null;
  function setUiBusy(busy){ invoke('set_ui_busy', { busy }).catch(() => {}); }
  function closeMenu(){
    if (!menu) return;
    menu.remove(); menu = null;
    document.removeEventListener('pointerdown', outside, true);
    setUiBusy(false);
  }
  function outside(e){ if (menu && !menu.contains(e.target)) closeMenu(); }

  async function openMenu(i, anchor){
    closeMenu();
    const p = hud.state(); if (!p) return;
    const bank = p.bank, current = p.banks[bank][i];
    const used = new Set(p.banks[bank].map((c, idx) => idx === i ? null : c.app_id).filter(Boolean));
    let sessions = [];
    try { sessions = await invoke('list_audio_sessions'); } catch (e) {}
    const list = sessions.filter(s => s.id === current.app_id || !used.has(s.id));

    menu = document.createElement('div'); menu.className = 'menu';
    const A = MixerHud.normalize(appearance);
    const addRow = (label, id, name, on) => {
      const r = document.createElement('div'); r.className = 'row' + (on ? ' on' : '');
      const dot = document.createElement('span'); dot.className = 'dot';
      if (id){ const t = MixerHud.tileFor(id, A); dot.style.setProperty('--tc', MixerHud.rgbStr(t.tc)); dot.style.setProperty('--fg', t.fg); dot.textContent = name.charAt(0).toUpperCase(); }
      else dot.textContent = '–';
      const txt = document.createElement('span'); txt.textContent = label;
      r.append(dot, txt);
      r.addEventListener('click', async (e) => {
        e.stopPropagation(); closeMenu();
        await invoke('assign_channel', { bank, channel: i, sessionId: id || null, displayName: id ? name : null });
      });
      menu.appendChild(r);
    };
    addRow('Empty slot', null, null, !current.app_id);
    const sep = document.createElement('div'); sep.className = 'sep'; menu.appendChild(sep);
    if (!list.length){ const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'No other apps are playing audio right now.'; menu.appendChild(e); }
    list.forEach(s => addRow(s.display_name, s.id, s.display_name, s.id === current.app_id));

    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.top = Math.round(r.bottom + 6) + 'px';
    menu.style.left = Math.round(Math.max(6, Math.min(window.innerWidth - menu.offsetWidth - 6, r.left + r.width / 2 - menu.offsetWidth / 2))) + 'px';
    setUiBusy(true);
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  }

  // ---- live glass: rim lensing over the real game ----
  // The backend sends a small JPEG of the screen under the overlay while it's
  // open. It's decoded off the main thread and handed to the HUD, which bends
  // it only in a thin band along the panel's edge (on the GPU). The middle is
  // left alone: there it's the real game, live, seen through the window.
  let liveOn = false, lastFrameAt = 0, expanded = false, decoding = false, lastBitmap = null;
  function liveEnabled(){ return MixerHud.normalize(appearance).liveGlass; }
  function setLive(on){
    if (on === liveOn) return;
    liveOn = on;
    if (!on){ hud.clearRim(); if (lastBitmap){ lastBitmap.close(); lastBitmap = null; } }
  }
  function b64ToBlob(b64){
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: 'image/jpeg' });
  }
  listen('backdrop-frame', async e => {
    if (!expanded || !liveEnabled() || decoding) return;   // drop a frame rather than queue up behind a decode
    decoding = true;
    try {
      const bmp = await createImageBitmap(b64ToBlob(e.payload));
      if (!expanded || !liveEnabled()){ bmp.close(); return; }
      hud.setRimSource(bmp, { x: 0, y: 0, w: innerWidth, h: innerHeight });   // the frame covers the whole window
      if (lastBitmap) lastBitmap.close();
      lastBitmap = bmp; lastFrameAt = performance.now(); liveOn = true;
    } catch (err) {} finally { decoding = false; }
  });
  // frames stop when the overlay closes or live glass is turned off. A still
  // screen only sends one frame a second (the backend skips repeats), so
  // anything under 1 s here would make the rim blink on and off.
  setInterval(() => { if (liveOn && performance.now() - lastFrameAt > 2500) setLive(false); }, 250);

  // ---- backend wiring ----
  let lastBank = -1, lastExpanded = null;
  function onState(p){
    hud.setState(p);
    expanded = !!p.expanded;
    if (!expanded) setLive(false);
    if ((lastBank !== -1 && p.bank !== lastBank) || (lastExpanded && !p.expanded)) closeMenu();
    lastBank = p.bank; lastExpanded = p.expanded;
  }
  function onAppearance(a){ appearance = a; hud.setAppearance(a); if (!liveEnabled()) setLive(false); }

  listen('overlay-state', e => onState(e.payload));
  listen('appearance-changed', e => onAppearance(e.payload));
  invoke('get_appearance').then(onAppearance).catch(() => {});
  invoke('get_state').then(onState).catch(() => {});
})();
