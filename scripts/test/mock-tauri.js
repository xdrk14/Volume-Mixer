// Fake Tauri backend for testing the real dist pages in a plain browser.
(function(){
  const listeners = {};
  const payload = {
    connected: true, expanded: true, bank: 0, channel: 0, hold: null,
    banks: [
      [ {app_id:'brave', app_name:'Brave', volume:72, muted:false, solo:false},
        {app_id:'spotify', app_name:'Spotify', volume:48, muted:true, solo:false},
        {app_id:'discord', app_name:'Discord', volume:35, muted:false, solo:false},
        {app_id:null, app_name:null, volume:0, muted:false, solo:false} ],
      [ {app_id:'chrome', app_name:'Chrome', volume:60, muted:false, solo:false},
        {app_id:'steamwebhelper', app_name:'Steam', volume:40, muted:false, solo:false},
        {app_id:'obs64', app_name:'OBS', volume:55, muted:false, solo:false},
        {app_id:'zoom', app_name:'Zoom', volume:30, muted:false, solo:false} ],
      [ {app_id:'vlc', app_name:'VLC', volume:80, muted:false, solo:false},
        {app_id:null, app_name:null, volume:0, muted:false, solo:false},
        {app_id:null, app_name:null, volume:0, muted:false, solo:false},
        {app_id:null, app_name:null, volume:0, muted:false, solo:false} ]
    ]
  };
  const log = [];
  let appearance = null, uiBusy = false;
  const clone = o => JSON.parse(JSON.stringify(o));
  function emit(evt, data){ (listeners[evt] || []).forEach(cb => cb({ event: evt, payload: clone(data) })); }
  const commands = {
    get_state: () => clone(payload),
    get_appearance: () => appearance,
    set_appearance: ({appearance: a}) => { appearance = a; emit('appearance-changed', a); },
    get_config: () => ({ last_port: 'COM3' }),
    get_serial_ports: () => ['COM3', 'COM5'],
    connect_serial_port: ({port}) => { if (port !== 'COM3') throw 'Access is denied.'; },
    list_audio_sessions: () => [{id:'brave',display_name:'Brave'},{id:'spotify',display_name:'Spotify'},{id:'discord',display_name:'Discord'},{id:'firefox',display_name:'Firefox'}],
    assign_channel: ({bank, channel, sessionId, displayName}) => { Object.assign(payload.banks[bank][channel], {app_id:sessionId, app_name:displayName, muted:false}); emit('overlay-state', payload); },
    set_ui_busy: ({busy}) => { uiBusy = busy; },
  };
  window.__TAURI__ = {
    core: { invoke: async (cmd, args) => { log.push([cmd, args]); if (!commands[cmd]) throw 'unknown command ' + cmd; return commands[cmd](args || {}); } },
    event: { listen: async (evt, cb) => { (listeners[evt] = listeners[evt] || []).push(cb); return () => {}; } },
  };
  window.__mock = { payload, emit, log, get appearance(){ return appearance; }, get uiBusy(){ return uiBusy; },
    push(mut){ mut(payload); emit('overlay-state', payload); } };
})();
