// Overlay HUD — driven by real hardware via Tauri events instead of the
// mockup's mouse-simulated joystick/knobs. Navigation, bank/channel
// selection, mute-toggle timing, and expand/collapse are all decided in
// the Rust backend (serial.rs) from the Arduino's serial stream; this file
// only renders the resulting state and handles the two mouse-only
// interactions (app assignment dropdown, per-channel color settings).

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const BANK_COUNT = 3;
const CHANNEL_COUNT = 4;
const SEGS = 10;
const SEL_PAD = 6; // uniform outward margin so the ring reads centered around the card

const overlayEl = document.getElementById('overlay');
const panelEl = document.getElementById('panel');
const ticksEl = document.getElementById('ticks');
const channelRowEl = document.getElementById('channelRow');
const selFrameEl = document.getElementById('selFrame');
const hintEl = document.getElementById('hint');
const holdLblEl = document.getElementById('holdLbl');
const holdBarEl = document.getElementById('holdBar');
const holdFillEl = holdBarEl.querySelector('i');

// ---- look settings (accent, corner radius, hold bar) from the settings window ----
const LOOK_DEFAULTS = { accentColor: '#ffffff', cornerRadius: 22, holdBar: true, animSpeed: 1 };
let look = { ...LOOK_DEFAULTS };
function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return isNaN(n) ? '255 255 255' : [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(' ');
}
function applyLook(a) {
  look = { ...LOOK_DEFAULTS };
  for (const k in LOOK_DEFAULTS) if (a && a[k] !== undefined && a[k] !== null) look[k] = a[k];
  const root = document.documentElement.style;
  root.setProperty('--acc-rgb', hexToRgb(look.accentColor));
  root.setProperty('--radius', look.cornerRadius + 'px');
  root.setProperty('--spd', String(look.animSpeed || 1));
  if (payload) render(payload);
}

// press-and-hold progress: the backend reports it ~20x a second and it rises
// one full bar per second, so the frame loop fills the bar smoothly in between
let holdP = -1, holdAt = 0;
function renderHold(p) {
  const h = p.expanded && look.holdBar ? p.hold : null;
  hintEl.classList.toggle('holding', !!h);
  if (!h) { holdP = -1; return; }
  holdP = h.progress; holdAt = performance.now();
  holdLblEl.textContent = (h.current ? h.current.toUpperCase() + ' · ' : 'HOLD · ') + 'next: ' + h.next;
  holdBarEl.className = h.next === 'mute' ? 'mute' : h.next === 'solo' ? 'solo' : '';
}

let payload = null;   // last OverlayPayload from the backend
let firstRender = true;

// While a channel's color settings panel is open, its bg/sel color is
// driven live from the picker rather than from the backend echo — the
// backend round-trip (invoke -> persist -> emit) is slower than a drag
// generates 'input' events, so without this guard the server's slightly
// stale echoes race the live drag and the color flickers/pops between
// old and new values.
let editingColor = null; // { bank, channel, bg, sel } | null

// client-side visual smoothing only — never drives the real OS volume call,
// which the backend sets directly/immediately off the raw knob value
let dispVol = Array.from({ length: BANK_COUNT }, () => new Array(CHANNEL_COUNT).fill(0));
let peak = Array.from({ length: BANK_COUNT }, () => new Array(CHANNEL_COUNT).fill(0));
let selX = 0, selXTarget = 0, selV = 0;

function segColor(segIdx) {
  const segFrac = (segIdx + 1) / SEGS;
  if (segFrac > 0.9) return 'var(--hotc)';
  if (segFrac > 0.7) return 'var(--midc)';
  return 'var(--lowc)';
}

function iconGlyph(name) {
  if (!name) return '＋'; // "＋"
  const ch = name.trim().charAt(0).toUpperCase();
  return ch || '♪';
}

// per-channel element refs for the frame loop, rebuilt with the bank
let chanEls = [];

function buildChannelDom(p) {
  channelRowEl.querySelectorAll('.chan').forEach(n => n.remove());
  chanEls = [];
  const bankChans = p.banks[p.bank];
  bankChans.forEach((ch, i) => {
    const el = document.createElement('div');
    el.className = 'chan' + (ch.app_id ? '' : ' empty') + (i === p.channel ? ' selected' : '')
      + (ch.muted ? ' muted' : '') + (ch.solo ? ' solo' : '');
    el.dataset.i = i;
    let segsHtml = '';
    for (let s = 0; s < SEGS; s++) segsHtml += `<div class="seg" data-s="${s}"></div>`;
    el.innerHTML = `
      <div class="gearBtn" title="settings">&#9881;</div>
      <div class="assignArea">
        <div class="logo">${escapeHtml(iconGlyph(ch.app_name))}</div>
        <div class="name">${ch.app_name ? escapeHtml(ch.app_name) : 'assign'}</div>
      </div>
      <div class="meter">${segsHtml}<div class="peakLine"></div></div>
      <div class="muteBtn">${ch.muted ? 'muted' : 'mute'}</div>
      <div class="soloBtn">solo</div>`;
    const editing = editingColor && editingColor.bank === p.bank && editingColor.channel === i;
    el.style.background = (editing ? editingColor.bg : ch.bg_color) || '';
    channelRowEl.appendChild(el);
    chanEls[i] = { el, segs: Array.from(el.querySelectorAll('.seg')), peak: el.querySelector('.peakLine') };

    el.querySelector('.assignArea').addEventListener('click', e => {
      e.stopPropagation();
      openDropdown(i, el.querySelector('.assignArea'));
    });
    el.querySelector('.gearBtn').addEventListener('click', e => {
      e.stopPropagation();
      openSettingsPanel(i, el.querySelector('.gearBtn'));
    });
  });
}

function updateChannelStatic(p) {
  const bankChans = p.banks[p.bank];
  bankChans.forEach((ch, i) => {
    const el = channelRowEl.querySelector('.chan[data-i="' + i + '"]');
    if (!el) return;
    el.classList.toggle('empty', !ch.app_id);
    el.classList.toggle('selected', i === p.channel);
    el.classList.toggle('muted', !!ch.muted);
    el.classList.toggle('solo', !!ch.solo);
    const editing = editingColor && editingColor.bank === p.bank && editingColor.channel === i;
    el.style.background = (editing ? editingColor.bg : ch.bg_color) || '';
    el.querySelector('.logo').textContent = iconGlyph(ch.app_name);
    el.querySelector('.name').textContent = ch.app_name || 'assign';
    const mb = el.querySelector('.muteBtn');
    mb.textContent = ch.muted ? 'muted' : 'mute';
  });
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function updateTicks(bank) {
  ticksEl.querySelectorAll('.tick').forEach((t, i) => t.classList.toggle('active', i === bank));
}

function pulseTick(bank) {
  const t = ticksEl.children[bank];
  if (!t) return;
  t.classList.remove('pulse');
  void t.offsetWidth;
  t.classList.add('pulse');
  t.addEventListener('animationend', () => t.classList.remove('pulse'), { once: true });
}

function flashChannel(i) {
  const el = channelRowEl.querySelector('.chan[data-i="' + i + '"]');
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 180);
}

// Measures the actual selected .chan box and pads it out evenly on all 4
// sides — this is what actually fixed the misaligned/lopsided highlight;
// hand-computed offsets kept drifting from the real rendered layout.
function applySelGeometry(instant) {
  const el = channelRowEl.querySelector('.chan[data-i="' + payload.channel + '"]');
  if (!el) return;
  selFrameEl.style.width = (el.offsetWidth + SEL_PAD * 2) + 'px';
  selFrameEl.style.height = (el.offsetHeight + SEL_PAD * 2) + 'px';
  selFrameEl.style.top = (el.offsetTop - SEL_PAD) + 'px';
  selXTarget = el.offsetLeft - SEL_PAD;
  if (instant) { selX = selXTarget; selV = 0; selFrameEl.style.transform = 'translate3d(' + Math.round(selX) + 'px,0,0)'; }
}

function refreshSelectionAppearance(p) {
  const ch = p.banks[p.bank][p.channel];
  const editing = editingColor && editingColor.bank === p.bank && editingColor.channel === p.channel;
  const selColor = editing ? editingColor.sel : ch.sel_color;
  // solo and muted are mutually exclusive (soloing a channel un-mutes it),
  // both override any custom selection color — same as muted always did
  selFrameEl.classList.toggle('solo', !!ch.solo);
  selFrameEl.classList.toggle('muted', !ch.solo && !!ch.muted);
  if (!ch.solo && !ch.muted && selColor) {
    selFrameEl.style.borderColor = selColor;
    selFrameEl.style.background = selColor + '2a';
    selFrameEl.style.boxShadow = '0 0 14px ' + selColor + '55';
  } else {
    selFrameEl.style.borderColor = '';
    selFrameEl.style.background = '';
    selFrameEl.style.boxShadow = '';
  }
}

function render(p) {
  const prev = payload;
  payload = p;

  document.body.classList.toggle('disconnected', !p.connected);

  const bankChanged = !prev || prev.bank !== p.bank;
  const expandChanged = !prev || prev.expanded !== p.expanded;

  overlayEl.className = p.expanded ? 'expanded' : 'collapsed';

  if (ticksEl.children.length !== BANK_COUNT) {
    ticksEl.innerHTML = '';
    for (let i = 0; i < BANK_COUNT; i++) {
      const t = document.createElement('div');
      t.className = 'tick';
      ticksEl.appendChild(t);
    }
  }
  updateTicks(p.bank);

  if (bankChanged) {
    buildChannelDom(p);
    if (!firstRender) {
      pulseTick(p.bank);
      const dir = prev && p.bank < prev.bank ? -1 : 1;
      const spd = look.animSpeed || 1;
      channelRowEl.querySelectorAll('.chan').forEach((el, i) => el.animate(
        [{ opacity: 0, transform: 'translate3d(0,' + (dir * 12) + 'px,0) scale(.96)' }, { opacity: 1, transform: 'none' }],
        { duration: 320 / spd, delay: (i * 40) / spd, easing: 'cubic-bezier(.2,1.1,.35,1)', fill: 'backwards' }));
    }
    closeDropdown();
    closeSettingsPanel();
  } else {
    updateChannelStatic(p);
  }

  if (expandChanged && p.expanded) {
    panelEl.classList.remove('poweron');
    void panelEl.offsetWidth;
    panelEl.classList.add('poweron');
    panelEl.querySelector('.sweep').addEventListener('animationend', () => panelEl.classList.remove('poweron'), { once: true });
  }
  if (expandChanged && !p.expanded) {
    closeDropdown();
    closeSettingsPanel();
  }

  if (prev && !bankChanged) {
    for (let c = 0; c < CHANNEL_COUNT; c++) {
      if (prev.banks[p.bank][c].muted !== p.banks[p.bank][c].muted) flashChannel(c);
    }
  }

  applySelGeometry(firstRender);
  refreshSelectionAppearance(p);
  renderHold(p);
  startLoop();

  firstRender = false;
}

// While either mouse-only panel below is open, hardware nav/mute input is
// told to back off (see set_ui_busy in commands.rs) so a joystick nudge —
// or just drift — can't switch bank/channel or mute out from under an
// in-progress edit and yank the panel closed on you.
function setUiBusy(busy) {
  invoke('set_ui_busy', { busy }).catch(() => {});
}

// ---- mouse-only: app assignment dropdown ----
function closeDropdown() {
  const dd = document.getElementById('appDropdown');
  if (dd) dd.remove();
  document.removeEventListener('click', onDocClickDropdown);
  setUiBusy(false);
}
function onDocClickDropdown(e) {
  const dd = document.getElementById('appDropdown');
  if (dd && !dd.contains(e.target)) closeDropdown();
}

async function openDropdown(i, anchorEl) {
  closeDropdown();
  closeSettingsPanel();
  const bank = payload.bank;
  const current = payload.banks[bank][i];
  const usedIds = new Set(
    payload.banks[bank]
      .map((c, idx) => (idx === i ? null : c.app_id))
      .filter(Boolean)
  );

  let sessions = [];
  try {
    sessions = await invoke('list_audio_sessions');
  } catch (e) {
    sessions = [];
  }
  const list = sessions.filter(s => s.id === current.app_id || !usedIds.has(s.id));

  const rect = anchorEl.getBoundingClientRect();
  const dd = document.createElement('div');
  dd.id = 'appDropdown';
  dd.style.top = (rect.bottom + 6) + 'px';
  dd.style.left = Math.max(6, rect.left + rect.width / 2 - 85) + 'px';

  const emptyRow = document.createElement('div');
  emptyRow.className = 'ddRow' + (!current.app_id ? ' ddActive' : '');
  emptyRow.innerHTML = '<span class="ddIcon">–</span><span>empty slot</span>';
  emptyRow.onclick = async e => {
    e.stopPropagation();
    closeDropdown();
    await invoke('assign_channel', { bank, channel: i, sessionId: null, displayName: null });
  };
  dd.appendChild(emptyRow);
  const div = document.createElement('div');
  div.className = 'ddDivider';
  dd.appendChild(div);

  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ddEmpty';
    empty.textContent = 'no other audio apps running';
    dd.appendChild(empty);
  }

  list.forEach(s => {
    const row = document.createElement('div');
    row.className = 'ddRow' + (current.app_id === s.id ? ' ddActive' : '');
    row.innerHTML = `<span class="ddIcon">${escapeHtml(iconGlyph(s.display_name))}</span><span>${escapeHtml(s.display_name)}</span>`;
    row.onclick = async e => {
      e.stopPropagation();
      closeDropdown();
      await invoke('assign_channel', { bank, channel: i, sessionId: s.id, displayName: s.display_name });
    };
    dd.appendChild(row);
  });

  document.body.appendChild(dd);
  setUiBusy(true);
  setTimeout(() => document.addEventListener('click', onDocClickDropdown), 0);
}

// ---- mouse-only: per-channel background + selection color settings ----
// Stays open until its own × is clicked (or another gear is clicked) —
// no outside-click auto-dismiss, so dragging a color picker never gets
// interrupted.
function closeSettingsPanel() {
  const p = document.getElementById('settingsPanel');
  if (p) p.remove();
  if (editingColor) {
    // guarantee the last-dragged value lands even if a throttled send was
    // still pending when the panel closed
    invoke('set_channel_colors', {
      bank: editingColor.bank, channel: editingColor.channel,
      bgColor: editingColor.bg, selColor: editingColor.sel,
    });
  }
  editingColor = null;
  setUiBusy(false);
}

// Backend calls are throttled during a drag (color pickers fire 'input'
// dozens of times/sec) — the local preview still updates every event, only
// the invoke + disk-persist is coalesced.
function throttle(fn, ms) {
  let lastCall = 0, timer = null;
  return (...args) => {
    const now = performance.now();
    const remaining = ms - (now - lastCall);
    if (remaining <= 0) {
      lastCall = now;
      fn(...args);
    } else {
      clearTimeout(timer);
      timer = setTimeout(() => { lastCall = performance.now(); fn(...args); }, remaining);
    }
  };
}

function openSettingsPanel(i, anchorEl) {
  closeSettingsPanel();
  closeDropdown();
  const bank = payload.bank;
  const ch = payload.banks[bank][i];
  const bg = ch.bg_color || '#000000';
  const sel = ch.sel_color || look.accentColor;
  editingColor = { bank, channel: i, bg, sel };

  const rect = anchorEl.getBoundingClientRect();
  const p = document.createElement('div');
  p.id = 'settingsPanel';
  p.style.top = (rect.bottom + 8) + 'px';
  p.style.left = Math.max(6, rect.left - 70) + 'px';
  p.innerHTML = `
    <div class="spHead"><span>channel settings</span><span class="spClose">&times;</span></div>
    <div class="spRow"><span>background</span><input type="color" id="spBg"></div>
    <div class="spRow"><span>selection</span><input type="color" id="spSel"></div>
  `;
  p.querySelector('#spBg').value = bg;
  p.querySelector('#spSel').value = sel;
  document.body.appendChild(p);
  p.addEventListener('click', e => e.stopPropagation());
  p.querySelector('.spClose').addEventListener('click', closeSettingsPanel);

  const sendColors = throttle(() => {
    invoke('set_channel_colors', { bank, channel: i, bgColor: editingColor.bg, selColor: editingColor.sel });
  }, 50);

  p.querySelector('#spBg').addEventListener('input', e => {
    editingColor.bg = e.target.value;
    const el = channelRowEl.querySelector('.chan[data-i="' + i + '"]');
    if (el) el.style.background = editingColor.bg;
    sendColors();
  });
  p.querySelector('#spSel').addEventListener('input', e => {
    editingColor.sel = e.target.value;
    if (i === payload.channel && bank === payload.bank) refreshSelectionAppearance(payload);
    sendColors();
  });

  setUiBusy(true);
}

// ---- rAF loop: lerp selection frame + per-channel volume/peak, paint meters ----
let last = performance.now();
let rafId = 0;
function startLoop() {
  if (rafId || !payload || !payload.expanded) return;
  last = performance.now();
  rafId = requestAnimationFrame(loop);
}
function loop(now) {
  rafId = 0;
  if (!payload || !payload.expanded) return;
  const dt = Math.min(48, now - last);
  last = now;

  if (payload) {
    // a lightly damped spring: glides over with a hint of settle, sub-pixel
    // smooth while moving, then snaps to a whole pixel at rest so the 1.5px
    // border is crisp (a fractional resting offset blurs it in WebView2)
    if (selX !== selXTarget || selV !== 0) {
      const w = 0.032 * (look.animSpeed || 1);          // stiffness, per ms
      for (let t = dt; t > 0; t -= 8) {
        const h = Math.min(8, t);
        selV += (w * w * (selXTarget - selX) - 2 * 0.82 * w * selV) * h;
        selX += selV * h;
      }
      if (Math.abs(selXTarget - selX) < 0.25 && Math.abs(selV) < 0.004) { selX = selXTarget; selV = 0; }
      const out = selV === 0 ? Math.round(selX) : selX;
      selFrameEl.style.transform = 'translate3d(' + out + 'px,0,0)';
    }

    const bank = payload.bank;
    payload.banks[bank].forEach((ch, i) => {
      const target = ch.app_id ? ch.volume : 0;
      dispVol[bank][i] += (target - dispVol[bank][i]) * Math.min(1, dt / 40);
      if (dispVol[bank][i] > peak[bank][i]) peak[bank][i] = dispVol[bank][i];
      else peak[bank][i] = Math.max(dispVol[bank][i], peak[bank][i] - dt * 0.035);

      const c = chanEls[i];
      if (!c) return;
      const el = c.el;
      const v = ch.muted ? 2 : dispVol[bank][i];
      const lit = Math.round((v / 100) * SEGS);
      if (el._lit !== lit) {
        el._lit = lit;
        c.segs.forEach((seg, s) => {
          const isLit = s < lit;
          seg.classList.toggle('lit', isLit);
          seg.style.color = isLit ? segColor(s) : '';
          seg.style.background = isLit ? segColor(s) : '#1c1c1c';
        });
      }
      const peakY = Math.round((peak[bank][i] / 100) * 92 * 2) / 2;
      if (el._peak !== peakY) {
        el._peak = peakY;
        const peakEl = c.peak;
        if (peakEl) peakEl.style.transform = 'translate3d(0,' + (-peakY) + 'px,0)';
      }
    });
  }

  if (holdP >= 0) holdFillEl.style.transform = 'scaleX(' + Math.min(1, holdP + (now - holdAt) / 1000).toFixed(4) + ')';

  rafId = requestAnimationFrame(loop);
}

listen('overlay-state', event => render(event.payload));
listen('appearance-changed', event => applyLook(event.payload));
invoke('get_appearance').then(applyLook).catch(() => {});
invoke('get_state').then(render).catch(() => {});
