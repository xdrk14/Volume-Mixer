const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const connStateEl = document.getElementById('connState');
const portSelectEl = document.getElementById('portSelect');
const portHintEl = document.getElementById('portHint');
const banksEl = document.getElementById('banks');

async function refreshPorts(preferPort) {
  let ports = [];
  try {
    ports = await invoke('get_serial_ports');
  } catch (e) {
    ports = [];
  }
  portSelectEl.innerHTML = '';
  if (ports.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = 'no serial ports found';
    opt.disabled = true;
    portSelectEl.appendChild(opt);
    return;
  }
  ports.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    portSelectEl.appendChild(opt);
  });
  if (preferPort && ports.includes(preferPort)) {
    portSelectEl.value = preferPort;
  }
}

document.getElementById('refreshPorts').addEventListener('click', () => refreshPorts());

document.getElementById('connectBtn').addEventListener('click', async () => {
  const port = portSelectEl.value;
  if (!port) return;
  portHintEl.textContent = 'connecting to ' + port + '…';
  try {
    await invoke('connect_serial_port', { port });
    portHintEl.textContent = 'connected to ' + port + ' (saved as default)';
  } catch (e) {
    portHintEl.textContent = 'failed to open ' + port + ': ' + e;
  }
});

function renderConnState(connected) {
  connStateEl.textContent = connected ? 'CONNECTED' : 'DISCONNECTED';
  connStateEl.className = 'badge ' + (connected ? 'ok' : 'bad');
}

function renderBanks(p) {
  banksEl.innerHTML = '';
  p.banks.forEach((chans, b) => {
    const row = document.createElement('div');
    row.className = 'bankRow';
    const tag = document.createElement('div');
    tag.className = 'bankTag' + (b === p.bank ? ' active' : '');
    tag.textContent = 'BANK ' + (b + 1);
    row.appendChild(tag);

    const chips = document.createElement('div');
    chips.className = 'chips';
    chans.forEach((ch, c) => {
      const chip = document.createElement('div');
      const classes = ['chip'];
      if (ch.app_id) classes.push('assigned');
      if (ch.muted) classes.push('muted');
      if (b === p.bank && c === p.channel) classes.push('selected');
      chip.className = classes.join(' ');
      chip.textContent = ch.app_name ? ch.app_name : 'empty';
      chips.appendChild(chip);
    });
    row.appendChild(chips);
    banksEl.appendChild(row);
  });
}

function applyState(p) {
  renderConnState(p.connected);
  renderBanks(p);
}

async function init() {
  const cfg = await invoke('get_config').catch(() => null);
  await refreshPorts(cfg ? cfg.last_port : null);
  const state = await invoke('get_state').catch(() => null);
  if (state) applyState(state);
}

listen('overlay-state', event => applyState(event.payload));
init();
