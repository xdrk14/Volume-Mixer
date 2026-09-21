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
let selX = 0, selXTarget = 0;

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

function buildChannelDom(p) {
  channelRowEl.querySelectorAll('.chan').forEach(n => n.remove());
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
        <div class="logo">${iconGlyph(ch.app_name)}</div>
        <div class="name">${ch.app_name ? escapeHtml(ch.app_name) : 'assign'}</div>
      </div>
      <div class="meter">${segsHtml}<div class="peakLine"></div></div>
      <div class="muteBtn">${ch.muted ? 'muted' : 'mute'}</div>
      <div class="soloBtn">solo</div>`;
    const editing = editingColor && editingColor.bank === p.bank && editingColor.channel === i;
    el.style.background = (editing ? editingColor.bg : ch.bg_color) || '';
    channelRowEl.appendChild(el);

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
  setTimeout(() => t.classList.remove('pulse'), 240);
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
  if (instant) selX = selXTarget;
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
    if (!firstRender) pulseTick(p.bank);
    closeDropdown();
    closeSettingsPanel();
  } else {
    updateChannelStatic(p);
  }

  if (expandChanged && p.expanded) {
    panelEl.classList.remove('poweron');
    void panelEl.offsetWidth;
    panelEl.classList.add('poweron');
    setTimeout(() => panelEl.classList.remove('poweron'), 340);
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
    row.innerHTML = `<span class="ddIcon">${iconGlyph(s.display_name)}</span><span>${escapeHtml(s.display_name)}</span>`;
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
  const bg = ch.bg_color || '#1b1e26';
  const sel = ch.sel_color || '#ffb454';
  editingColor = { bank, channel: i, bg, sel };

  const rect = anchorEl.getBoundingClientRect();
  const p = document.createElement('div');
  p.id = 'settingsPanel';
  p.style.top = (rect.bottom + 8) + 'px';
  p.style.left = Math.max(6, rect.left - 70) + 'px';
  p.innerHTML = `
    <div class="spHead"><span>channel settings</span><span class="spClose">&times;</span></div>
    <div class="spRow"><span>background</span><input type="color" id="spBg" value="${bg}"></div>
    <div class="spRow"><span>selection</span><input type="color" id="spSel" value="${sel}"></div>
  `;
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
function loop(now) {
  const dt = Math.min(48, now - last);
  last = now;

  if (payload) {
    selX += (selXTarget - selX) * Math.min(1, dt / 45);
    // round to a whole pixel — a fractional translateX blurs a 1.5px border
    // in WebView2, which is what read as a "broken"/fuzzy highlight
    const selXOut = Math.abs(selXTarget - selX) < 0.5 ? selXTarget : Math.round(selX);
    selFrameEl.style.transform = `translateX(${selXOut}px)`;

    const bank = payload.bank;
    payload.banks[bank].forEach((ch, i) => {
      const target = ch.app_id ? ch.volume : 0;
      dispVol[bank][i] += (target - dispVol[bank][i]) * Math.min(1, dt / 40);
      if (dispVol[bank][i] > peak[bank][i]) peak[bank][i] = dispVol[bank][i];
      else peak[bank][i] = Math.max(dispVol[bank][i], peak[bank][i] - dt * 0.035);

      const el = channelRowEl.querySelector('.chan[data-i="' + i + '"]');
      if (!el) return;
      const v = ch.muted ? 2 : dispVol[bank][i];
      const lit = Math.round((v / 100) * SEGS);
      el.querySelectorAll('.seg').forEach((seg, s) => {
        const isLit = s < lit;
        seg.classList.toggle('lit', isLit);
        seg.style.color = isLit ? segColor(s) : '';
        seg.style.background = isLit ? segColor(s) : '#20222a';
      });
      const peakEl = el.querySelector('.peakLine');
      if (peakEl) peakEl.style.bottom = (2 + (peak[bank][i] / 100) * 92) + 'px';
    });
  }

  requestAnimationFrame(loop);
}

listen('overlay-state', event => render(event.payload));
invoke('get_state').then(render).catch(() => {});
requestAnimationFrame(loop);
