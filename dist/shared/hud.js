/* Liquid-glass mixer HUD renderer, shared by the overlay window and the
   settings preview. Feed it the backend's `overlay-state` payload with
   setState() and the saved look with setAppearance(); it owns the DOM,
   the selection lens, all animations and the meters. */
(function(){
  'use strict';

  var THEMES = [
    {id:'amber',   name:'Amber',    acc:'255 159 10',  tint:'14 12 10', sky:['#1b1740','#5a2f6e','#e0784a']},
    {id:'glacier', name:'Glacier',  acc:'100 210 255', tint:'6 14 26',  sky:['#081a33','#1c4f7a','#8fd3ea']},
    {id:'terminal',name:'Terminal', acc:'48 209 88',   tint:'2 10 6',   sky:['#03110a','#0a3322','#2b8a5a']},
    {id:'vapor',   name:'Vapor',    acc:'191 90 242',  tint:'22 8 34',  sky:['#1a0a33','#6a1f7a','#ff7ab8']},
    {id:'graphite',name:'Graphite', acc:'229 229 234', tint:'16 17 20', sky:['#121317','#2a2d35','#6b7080']},
    {id:'ember',   name:'Ember',    acc:'255 105 60',  tint:'22 8 6',   sky:['#1a0806','#5a1a10','#ff8a3d']}
  ];
  var STYLES = [{id:'droplet',name:'Droplet'},{id:'ring',name:'Ring'},{id:'underline',name:'Underline'},
    {id:'glow',name:'Glow'},{id:'spot',name:'Spotlight'},{id:'none',name:'None'}];
  var FONTS = [
    {n:'System', css:'"Segoe UI Variable","Segoe UI",system-ui,-apple-system,sans-serif', sys:true},
    {n:'Geist'},{n:'Inter'},{n:'Manrope'},{n:'DM Sans'},{n:'Plus Jakarta Sans'},{n:'Outfit'},
    {n:'Sora'},{n:'Figtree'},{n:'Space Grotesk'},{n:'Lexend'},{n:'Rubik'},{n:'JetBrains Mono', mono:true}
  ];
  var DEFAULTS = {theme:'amber', accent:null, mute:null, style:'droplet',
    refract:34, blur:1.5, rimW:26, chroma:55, shine:70, shineSpin:40, rimHot:60, tint:36, rim:80, radius:32, iconTint:34,
    glint:80, speed:2.8,
    motion:'springy', mspeed:1, bounce:60, stretch:18, openAnim:'morph', bankAnim:'slide', meterMs:40, ignoreSysMotion:false,
    font:'Geist', appColors:{},
    shade:40, halo:55, tintDark:0, bg:'#000000', bgA:0, bgBlur:0, liveGlass:true, captureFps:30, captureScale:3};
  var MUTE_DEFAULT = '#b10203';

  /* brand colors keyed by exe stem (the backend's app_id) */
  var BRANDS = {brave:'#fb542b', spotify:'#1ed760', discord:'#5865f2', chrome:'#3b82f6', firefox:'#ff7139',
    msedge:'#0f9fd8', opera:'#ff1b2d', operagx:'#fa1e4e', vivaldi:'#ef3939', steam:'#1b2838', steamwebhelper:'#1b2838',
    obs64:'#302e31', obs32:'#302e31', obs:'#302e31', zoom:'#0b5cff', vlc:'#ff8800', teams:'#6264a7', 'ms-teams':'#6264a7',
    slack:'#4a154b', whatsapp:'#25d366', telegram:'#27a7e7', code:'#0078d4', winamp:'#f5a623', foobar2000:'#3d8fd6',
    'epicgameslauncher':'#2a2a2a', battlenet:'#148eff', 'riotclientservices':'#d13639', valorant:'#ff4655',
    'league of legends':'#c89b3c', minecraft:'#62b47a', javaw:'#62b47a', applemusic:'#fa2d48', itunes:'#fa2d48',
    tidal:'#00ffff', deezer:'#a238ff', youtube:'#ff0000', twitch:'#9146ff', obsidian:'#7c3aed'};
  /* near-black brands vanish as a tint on dark glass: tint with their accent */
  var ALT_TINT = {steam:'#66c0f4', steamwebhelper:'#66c0f4', obs64:'#c9ccd4', obs32:'#c9ccd4', obs:'#c9ccd4',
    slack:'#e01e5a', epicgameslauncher:'#c9ccd4'};

  /* ---------- color helpers ---------- */
  function hexRgb(h){ h=String(h).replace('#',''); if (h.length===3) h=h.replace(/./g,'$&$&'); return [0,2,4].map(function(i){ return parseInt(h.substr(i,2),16)||0; }); }
  function rgbHex(a){ return '#'+a.map(function(v){ return ('0'+Math.max(0,Math.min(255,Math.round(v))).toString(16)).slice(-2); }).join(''); }
  function mix(h,to,t){ var a=hexRgb(h), b=hexRgb(to); return rgbHex(a.map(function(v,i){ return v+(b[i]-v)*t; })); }
  function lum(h){ var c=hexRgb(h).map(function(v){ v/=255; return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4); }); return .2126*c[0]+.7152*c[1]+.0722*c[2]; }
  function rgbStr(h){ return hexRgb(h).join(' '); }
  function hslHex(h,s,l){ s/=100; l/=100; var k=function(n){ return (n+h/30)%12; }, a=s*Math.min(l,1-l);
    var f=function(n){ return l-a*Math.max(-1,Math.min(k(n)-3,Math.min(9-k(n),1))); }; return rgbHex([f(0)*255,f(8)*255,f(4)*255]); }
  function hashColor(id){ var h=0; for (var i=0;i<id.length;i++) h=(h*31+id.charCodeAt(i))>>>0; return hslHex(h%360,68,58); }

  function clone(o){ return JSON.parse(JSON.stringify(o)); }
  function normalize(a){
    var out = clone(DEFAULTS);
    if (a && typeof a === 'object'){ for (var k in a) if (k in DEFAULTS && a[k] !== undefined) out[k] = a[k]; out.appColors = Object.assign({}, a.appColors); }
    return out;
  }
  function themeOf(A){ return THEMES.filter(function(t){ return t.id===A.theme; })[0] || THEMES[0]; }
  function tintRgb(A){ var t = themeOf(A).tint.split(' ').map(Number); return rgbStr(mix(rgbHex(t), '#000000', (A.tintDark || 0) / 100)); }
  function accentRgb(A){ return A.accent ? rgbStr(A.accent) : themeOf(A).acc; }
  function accentHex(A){ return A.accent || rgbHex(themeOf(A).acc.split(' ').map(Number)); }
  function brandBase(id){ return BRANDS[id] || hashColor(id || '?'); }
  function tileFor(id, A){
    var custom = A.appColors[id] && A.appColors[id].tile, base = custom || brandBase(id);
    var tc = (!custom && lum(base) < .03) ? (ALT_TINT[id] || '#c9ccd4') : base;
    return {base:base, tc:tc, fg:mix(tc,'#ffffff',.35)};
  }
  function fontOf(A){ return FONTS.filter(function(f){ return f.n===A.font; })[0] || FONTS[1]; }
  function fontCss(f){ return f.css || ('"'+f.n+'",'+(f.mono ? 'ui-monospace,monospace' : 'system-ui,sans-serif')); }
  var loadedFonts = {};
  function loadFont(f){
    if (f.sys || loadedFonts[f.n]) return; loadedFonts[f.n] = true;
    var l = document.createElement('link'); l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family='+f.n.replace(/ /g,'+')+':wght@400;500;600;700&display=swap';
    document.head.appendChild(l);
  }
  function isSystemReduced(){ return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); }


  /* ---------- rim lensing on the GPU ----------
     Only a thin band along the panel's edge bends what's behind it; the
     middle stays plain tinted glass (in the overlay that's the real game,
     live, with zero lag). One WebGL quad, early-out for every pixel outside
     the band, so the per-frame cost is a few thousand texture reads. */
  var RIM_VS = 'attribute vec2 a;varying vec2 v;void main(){v=vec2(a.x*.5+.5,.5-a.y*.5);gl_Position=vec4(a,0.,1.);}';
  var RIM_FS = [
    'precision mediump float;',
    'uniform sampler2D u_tex;uniform vec2 u_size;uniform vec4 u_map;uniform float u_r,u_band,u_k,u_blur,u_chroma,u_shine,u_ang,u_hot;',
    'uniform vec2 u_hotP;uniform vec3 u_acc;uniform float u_bgBlur,u_bgA,u_tintA;uniform vec3 u_bg,u_tint;varying vec2 v;',
    'float sd(vec2 p,vec2 b,float r){vec2 q=abs(p)-b+r;return length(max(q,0.))+min(max(q.x,q.y),0.)-r;}',
    'vec2 uv(vec2 p){return p*u_map.xy+u_map.zw;}',
    'void main(){',
    ' vec2 pos=v*u_size;vec2 c=pos-u_size*.5;vec2 b=u_size*.5;',
    ' float d=sd(c,b,u_r);',
    ' if(d>1.||(u_bgBlur<=0.&&-d>u_band)){gl_FragColor=vec4(0.);return;}',
    ' float edgeA=clamp(.5-d,0.,1.);vec3 mid=vec3(0.);',
    /* background blur: the whole panel shows the captured backdrop through a
       13-tap spiral blur, then the background color and tint on top */
    ' if(u_bgBlur>0.){',
    '  vec3 sum=texture2D(u_tex,uv(pos)).rgb;',
    '  for(int i=0;i<12;i++){float an=float(i)*2.39996;float rr=u_bgBlur*sqrt((float(i)+.5)/12.);sum+=texture2D(u_tex,uv(pos+vec2(cos(an),sin(an))*rr)).rgb;}',
    '  mid=mix(mix(sum/13.,u_bg,u_bgA),u_tint,u_tintA);',
    '  if(-d>u_band){gl_FragColor=vec4(mid*edgeA,edgeA);return;}',
    ' }',
    ' vec2 n=normalize(vec2(sd(c+vec2(1.,0.),b,u_r)-sd(c-vec2(1.,0.),b,u_r),sd(c+vec2(0.,1.),b,u_r)-sd(c-vec2(0.,1.),b,u_r))+1e-5);',
    /* t: 0 at the inner edge of the band, 1 at the glass edge. Convex-lens
       profile: the bend ramps up steeply toward the edge, like a real bead of glass */
    ' float t=clamp(1.-max(-d,0.)/u_band,0.,1.);float s=t*t*(3.-2.*t);float bend=1.-sqrt(max(1.-t*t,0.));',
    ' vec2 tg=vec2(-n.y,n.x);vec3 col=vec3(0.);vec2 k=n*(bend*u_k+s*u_k*.35);',
    ' for(int i=-1;i<=1;i++){vec2 o=tg*float(i)*u_blur;',
    '  col.r+=texture2D(u_tex,uv(pos-k*(1.+u_chroma*.25)+o)).r;col.g+=texture2D(u_tex,uv(pos-k+o)).g;col.b+=texture2D(u_tex,uv(pos-k*(1.-u_chroma*.3)+o)).b;}',
    ' col/=3.;float g=dot(col,vec3(.299,.587,.114));col=clamp(mix(vec3(g),col,1.35)*1.08,0.,1.);',
    /* moving specular: a light circles the panel; both the lit side and a
       fainter bounce on the far side, plus a thin bright lip at the edge */
    ' vec2 L=vec2(cos(u_ang),sin(u_ang));float lit=pow(max(dot(n,L),0.),3.)+.45*pow(max(dot(n,-L),0.),4.);',
    ' float spec=u_shine*(lit*pow(t,5.)*.9+pow(t,14.)*.35);',
    /* accent glow on the rim next to the selected channel */
    ' float hot=u_hot*exp(-pow(distance(pos,u_hotP)/(b.x*.45),2.))*pow(t,3.);',
    ' col+=vec3(spec)+u_acc*hot;',
    ' col=min(col,1.);',
    ' if(u_bgBlur>0.){gl_FragColor=vec4(mix(mid,col,s)*edgeA,edgeA);return;}',
    ' float a=s*edgeA;',
    ' gl_FragColor=vec4(col*a,a);',
    '}'].join('\n');
  function makeRim(canvas){
    var gl = canvas.getContext('webgl', {alpha:true, premultipliedAlpha:true, antialias:false, preserveDrawingBuffer:false});
    if (!gl) return null;
    function sh(type, src){ var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; }
    var prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, RIM_VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, RIM_FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'a'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    var tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T].forEach(function(p){ gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE); });
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    var U = {}; ['u_size','u_map','u_r','u_band','u_k','u_blur','u_chroma','u_shine','u_ang','u_hot','u_hotP','u_acc','u_bgBlur','u_bgA','u_tintA','u_bg','u_tint'].forEach(function(n){ U[n] = gl.getUniformLocation(prog, n); });
    return {
      draw: function(src, map, size, r, band, k, blur, fx, upload){
        var dpr = window.devicePixelRatio || 1, w = Math.max(1, Math.round(size[0]*dpr)), h = Math.max(1, Math.round(size[1]*dpr));
        if (canvas.width !== w || canvas.height !== h){ canvas.width = w; canvas.height = h; }
        gl.viewport(0, 0, w, h);
        if (upload) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
        gl.uniform2f(U.u_size, size[0], size[1]); gl.uniform4f(U.u_map, map[0], map[1], map[2], map[3]);
        gl.uniform1f(U.u_r, r); gl.uniform1f(U.u_band, band); gl.uniform1f(U.u_k, k); gl.uniform1f(U.u_blur, blur);
        gl.uniform1f(U.u_chroma, fx.chroma); gl.uniform1f(U.u_shine, fx.shine); gl.uniform1f(U.u_ang, fx.ang);
        gl.uniform1f(U.u_hot, fx.hot); gl.uniform2f(U.u_hotP, fx.hotP[0], fx.hotP[1]); gl.uniform3f(U.u_acc, fx.acc[0], fx.acc[1], fx.acc[2]);
        gl.uniform1f(U.u_bgBlur, fx.bgBlur); gl.uniform1f(U.u_bgA, fx.bgA); gl.uniform1f(U.u_tintA, fx.tintA);
        gl.uniform3f(U.u_bg, fx.bg[0], fx.bg[1], fx.bg[2]); gl.uniform3f(U.u_tint, fx.tint[0], fx.tint[1], fx.tint[2]);
        gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    };
  }

  var instances = 0;
  var STAGE_LABEL = {normal:'normal', mute:'mute', solo:'solo'};

  function create(root, opts){
    opts = opts || {};
    instances++;
    root.innerHTML =
      '<div class="hud collapsed sel-droplet no-backdrop"><div class="panel"><canvas class="rim"></canvas><div class="inner">' +
        '<div class="ticks"><div class="tick"></div><div class="tick"></div><div class="tick"></div></div>' +
        '<div class="row"><div class="lens"></div></div>' +
        '<div class="hint"><span class="hintTxt"></span><span class="bar"><i></i></span></div>' +
      '</div></div></div>';

    var hud = root.querySelector('.hud'), panel = hud.querySelector('.panel'), row = hud.querySelector('.row'),
        lens = hud.querySelector('.lens'), ticks = hud.querySelector('.ticks'), hint = hud.querySelector('.hint'),
        hintTxt = hud.querySelector('.hintTxt'), hintBar = hud.querySelector('.bar i');
    var rimCanvas = hud.querySelector('.rim'), rim = null, rimSrc = null, rimRect = null, shineAng = -2.2, lastRimDraw = 0, lensHl = null;
    if (opts.shadow === false) hud.classList.add('no-shadow');
    if (opts.onPick) hud.classList.add('can-pick');

    var A = normalize(null), P = null, cards = [], builtSig = '', builtBank = -1, lastSig = '', hintState = '';
    var PAD = 7, lensX = 0, lensY = 0, first = true, lastChannel = -1, lastBank = -1;
    var disp = [[0,0,0,0],[0,0,0,0],[0,0,0,0]];

    function reduced(){ return isSystemReduced() && !A.ignoreSysMotion; }
    function canAnimate(){ return A.motion !== 'off' && !reduced(); }
    function dur(ms){ return ms / (A.mspeed || 1); }
    function bounce(){ return A.motion === 'springy' ? A.bounce/100 : 0; }
    function ease(){ return A.motion === 'springy' ? 'cubic-bezier(.3,'+(1+bounce()*.7).toFixed(2)+',.45,1)' : 'cubic-bezier(.2,.7,.2,1)'; }

    /* src: image/bitmap/canvas; rect: where that source sits on screen, in
       viewport CSS px. Maps each rim pixel to the source pixel behind it. */
    function rimWanted(){ return !!rimSrc && (A.refract > 0 || A.bgBlur > 0); }
    function drawRim(upload){
      var on = rimWanted();
      hud.classList.toggle('has-rim', on);
      hud.classList.toggle('bg-blur', on && A.bgBlur > 0);
      if (!on) return;
      if (!rim){ rim = makeRim(rimCanvas); if (!rim){ rimSrc = null; hud.classList.remove('has-rim'); return; } upload = true; }
      var pr = panel.getBoundingClientRect(), w = panel.offsetWidth, h = panel.offsetHeight;
      if (!w || !h || !pr.width) return;
      var sx = pr.width / w, sy = pr.height / h;
      var map = [sx / rimRect.w, sy / rimRect.h, (pr.left - rimRect.x) / rimRect.w, (pr.top - rimRect.y) / rimRect.h];
      var lr = lens.getBoundingClientRect(), hotP = [(lr.left + lr.width/2 - pr.left) / sx, (lr.top + lr.height/2 - pr.top) / sy];
      var acc = (lensHl || accentRgb(A)).split(' ').map(function(x){ return x/255; });
      function unit(rgb){ return rgb.split(' ').map(function(x){ return x/255; }); }
      var fx = {chroma: A.chroma/100, shine: A.shine/100, ang: shineAng, hot: lr.width ? A.rimHot/100 : 0, hotP: hotP, acc: acc,
        bgBlur: A.bgBlur, bgA: A.bgA/100, bg: unit(rgbStr(A.bg || '#000000')), tintA: A.tint/100, tint: unit(tintRgb(A))};
      // lensing off but blur on: a zero-width band leaves just the blurred fill
      var band = A.refract > 0 ? (A.rimW || 22) : 0.001;
      rim.draw(rimSrc, map, [w, h], Math.min(A.radius, w/2, h/2), band, A.refract, A.blur, fx, upload);
      lastRimDraw = performance.now();
    }
    function paintCard(c, ch){
      var el = c.el;
      if (ch.app_id){
        var t = tileFor(ch.app_id, A);
        el.style.setProperty('--tc', rgbStr(t.tc)); el.style.setProperty('--fg', t.fg);
        var hl = A.appColors[ch.app_id] && A.appColors[ch.app_id].hl;
        if (hl) el.style.setProperty('--hl-rgb', rgbStr(hl)); else el.style.removeProperty('--hl-rgb');
      }
    }

    function buildRow(dirSign){
      cards.forEach(function(c){ c.el.remove(); }); cards = [];
      var bank = P.banks[P.bank];
      bank.forEach(function(ch, i){
        var d = document.createElement('div'); d.className = 'ch' + (ch.app_id ? '' : ' empty'); d.dataset.i = i;
        var name = ch.app_name || (ch.app_id ? ch.app_id : 'Assign');
        var segs = ''; for (var s=0;s<10;s++) segs += '<div class="s"></div>';
        d.innerHTML = '<span class="fx"><i></i></span><span class="badge"></span>' +
          '<div class="pickable"><div class="ico"></div><div class="name"></div></div>' +
          '<div class="val">0%</div><div class="meter">'+segs+'</div><div class="pill m">mute</div>';
        d.querySelector('.ico').textContent = ch.app_id ? name.trim().charAt(0).toUpperCase() : '+';
        d.querySelector('.name').textContent = name;
        d.querySelector('.name').title = name;
        row.appendChild(d);
        var c = {el:d, segs:[].slice.call(d.querySelectorAll('.s')), val:d.querySelector('.val'), pm:d.querySelector('.pill.m'), lit:-1, txt:'', id:ch.app_id};
        paintCard(c, ch);
        if (opts.onPick){
          d.querySelector('.pickable').addEventListener('click', function(e){
            e.stopPropagation(); if (P && P.expanded) opts.onPick(i, d.querySelector('.pickable'));
          });
        }
        cards.push(c);
      });
      builtBank = P.bank;
      if (dirSign && canAnimate() && A.bankAnim !== 'none'){
        cards.forEach(function(c, i){
          var frames = A.bankAnim === 'slide'
            ? [{transform:'translateY('+(dirSign*18)+'px)',opacity:0},{transform:'translateY(0)',opacity:1}]
            : [{opacity:0},{opacity:1}];
          c.el.animate(frames, {duration:dur(300), delay:dur(i*38), easing:ease(), fill:'backwards'});
        });
        var tk = ticks.children[P.bank];
        if (tk && tk.animate) tk.animate([{transform:'scaleX(1.7)'},{transform:'scaleX(1)'}], {duration:dur(360), easing:ease()});
      }
    }

    function placeLens(animate){
      var c = cards[P.channel]; if (!c) return;
      var el = c.el, x=el.offsetLeft, y=el.offsetTop, w=el.offsetWidth, h=el.offsetHeight;
      var b = A.style==='underline' ? {x:x+w*.22,y:y+h+2,w:w*.56,h:3} : {x:x-PAD,y:y-PAD,w:w+PAD*2,h:h+PAD*2};
      lens.style.width = b.w+'px'; lens.style.height = b.h+'px';
      var from='translate('+lensX+'px,'+lensY+'px)', to='translate('+b.x+'px,'+b.y+'px)';
      lens.style.transform = to;
      if (animate && lens.animate && canAnimate() && (lensX!==b.x || lensY!==b.y)){
        if (A.motion==='springy'){
          var st=A.stretch/100, bb=bounce();
          lens.animate([{transform:from},
            {transform:'translate('+((lensX+b.x)/2)+'px,'+((lensY+b.y)/2)+'px) scale('+(1+st)+','+(1-st/3)+')',offset:.45},
            {transform:to+' scale('+(1-.04*bb)+','+(1+.03*bb)+')',offset:.78},{transform:to}],
            {duration:dur(440), easing:'cubic-bezier(.3,1,.45,1)'});
        } else lens.animate([{transform:from},{transform:to}], {duration:dur(260), easing:'cubic-bezier(.2,.7,.2,1)'});
      }
      lensX=b.x; lensY=b.y;
      var solo = el.classList.contains('solo'), muted = el.classList.contains('muted');
      lens.classList.toggle('onSolo', solo); lens.classList.toggle('onMute', muted);
      var hl = c.id && A.appColors[c.id] && A.appColors[c.id].hl;
      if (hl && !solo && !muted) lens.style.setProperty('--lt', rgbStr(hl)); else lens.style.removeProperty('--lt');
      lensHl = solo ? '10 132 255' : muted ? rgbStr(A.mute || MUTE_DEFAULT) : hl ? rgbStr(hl) : null;
      cards.forEach(function(cc){ cc.el.classList.toggle('sel', cc===c); });
    }

    function morph(open, animate){
      var b = bounce(), anim = animate && panel.animate && canAnimate(), kind = A.openAnim;
      if (!open){
        if (anim){
          var out = kind==='morph' ? {transform:'scale(.2,.06)',opacity:0} : kind==='pop' ? {transform:'scale(.85)',opacity:0}
            : kind==='slide' ? {transform:'translateY(-18px)',opacity:0} : {opacity:0};
          panel.animate([{transform:'none',opacity:1}, out], {duration:dur(220), easing:'cubic-bezier(.5,0,.75,0)'});
        }
        hud.classList.add('collapsed');
      } else {
        hud.classList.remove('collapsed');
        if (!anim) return;
        var f, d;
        if (kind==='morph'){ d=620; f=[{transform:'scale(.2,.06)',opacity:0},{transform:'scale('+(1+.06*b)+','+(1-.03*b)+')',opacity:1,offset:.55},{transform:'scale('+(1-.015*b)+','+(1+.015*b)+')',offset:.8},{transform:'scale(1)'}]; }
        else if (kind==='pop'){ d=380; f=[{transform:'scale(.8)',opacity:0},{transform:'scale('+(1+.05*b)+')',opacity:1,offset:.6},{transform:'scale(1)'}]; }
        else if (kind==='slide'){ d=340; f=[{transform:'translateY(-24px)',opacity:0},{transform:'translateY(0)',opacity:1}]; }
        else { d=220; f=[{opacity:0},{opacity:1}]; }
        panel.animate(f, {duration:dur(d), easing:(kind==='morph'||kind==='pop') ? 'cubic-bezier(.25,.9,.35,1)' : ease()});
      }
    }

    function renderHint(){
      var h = P && P.hold;
      if (h && P.expanded){
        hint.classList.add('holding');
        hintBar.style.transform = 'scaleX('+Math.max(0,Math.min(1,h.progress)).toFixed(3)+')';
        var t = (h.current ? STAGE_LABEL[h.current].toUpperCase()+' · ' : 'hold · ') + 'next: ' + STAGE_LABEL[h.next];
        if (hintTxt.textContent !== t) hintTxt.textContent = t;
        hintState = 'hold';
      } else if (hintState !== 'idle'){
        hint.classList.remove('holding'); hintBar.style.transform = 'scaleX(0)';
        hintTxt.textContent = opts.hint || 'click close · hold: normal → mute → solo';
        hintState = 'idle';
      }
    }

    function render(force){
      if (!P) return;
      var bank = P.banks[P.bank];
      var appsSig = P.bank + ':' + bank.map(function(c){ return (c.app_id||'') + '/' + (c.app_name||''); }).join('|');
      var sig = appsSig + '|' + P.channel + '|' + P.expanded + '|' +
        bank.map(function(c){ return (c.muted?1:0) + '' + (c.solo?1:0); }).join('');
      renderHint();
      if (sig === lastSig && !force) return;
      lastSig = sig;
      var bankChanged = lastBank !== -1 && lastBank !== P.bank;
      if (appsSig !== builtSig){
        var dirSign = (builtBank < 0 || !bankChanged) ? 0 : (P.bank > builtBank ? 1 : -1);
        buildRow(dirSign); builtSig = appsSig;
      }
      [].forEach.call(ticks.children, function(t,i){ t.classList.toggle('on', i===P.bank); });
      cards.forEach(function(c, i){
        var ch = bank[i];
        c.el.classList.toggle('muted', !!ch.app_id && !!ch.muted);
        c.el.classList.toggle('solo', !!ch.solo);
        var t = ch.muted ? 'muted' : 'mute'; if (c.pm.textContent !== t) c.pm.textContent = t;
      });
      var chChanged = lastChannel !== -1 && lastChannel !== P.channel;
      placeLens(!first && (chChanged || bankChanged));
      var expNow = !hud.classList.contains('collapsed');
      if (first) morph(P.expanded, false);
      else if (expNow !== !!P.expanded) morph(!!P.expanded, true);
      lastChannel = P.channel; lastBank = P.bank; first = false;
    }

    function apply(){
      var t = themeOf(A), s = hud.style;
      s.setProperty('--acc-rgb', accentRgb(A)); s.setProperty('--tint-rgb', tintRgb(A));
      s.setProperty('--shade', (A.shade/100).toFixed(2)); s.setProperty('--halo', (A.halo/100).toFixed(2));
      s.setProperty('--tint', (A.tint/100).toFixed(2)); s.setProperty('--rim', (A.rim/100).toFixed(2));
      s.setProperty('--r', A.radius+'px'); s.setProperty('--blurFallback', Math.max(A.blur*2,4)+'px');
      s.setProperty('--glint', (A.glint/100).toFixed(2)); s.setProperty('--glintDur', A.speed+'s');
      s.setProperty('--tile-a', (A.iconTint/100).toFixed(2));
      s.setProperty('--bg-rgb', rgbStr(A.bg || '#000000')); s.setProperty('--bg-a', (A.bgA/100).toFixed(2));
      s.setProperty('--mute-rgb', rgbStr(A.mute || MUTE_DEFAULT));
      var f = fontOf(A); loadFont(f); s.setProperty('--hud-font', fontCss(f));
      STYLES.forEach(function(x){ hud.classList.remove('sel-'+x.id); }); hud.classList.add('sel-'+A.style);
      hud.classList.toggle('motion-off', A.motion==='off');
      hud.classList.toggle('sys-reduced', reduced());
      drawRim(false);
      cards.forEach(function(c, i){ if (P) paintCard(c, P.banks[P.bank][i]); });
      if (P){ placeLens(false); }
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(function(){ if (P) placeLens(false); });
    }

    /* meters: lerp toward the knob value; DOM writes only on change */
    var lastT = performance.now(), raf = 0, alive = true;
    function meterLoop(now){
      if (!alive) return;
      var dt = Math.min(48, now - lastT); lastT = now;
      if (P){
        var b = P.bank, bank = P.banks[b], k = Math.min(1, dt / (A.meterMs || 40));
        cards.forEach(function(c, i){
          var ch = bank[i], asg = !!ch.app_id, target = asg ? ch.volume : 0, cur = disp[b][i];
          disp[b][i] = Math.abs(target-cur) > .05 ? cur + (target-cur)*k : target;
          var v = (asg && ch.muted) ? 2 : disp[b][i], lit = Math.round(v/10);
          if (lit !== c.lit){ c.segs.forEach(function(s,kk){ s.className = kk<lit ? (kk>=9?'s r':kk>=7?'s y':'s g') : 's'; }); c.lit = lit; }
          var txt = (asg ? ch.volume : 0) + '%'; if (txt !== c.txt){ c.val.textContent = txt; c.txt = txt; }
        });
      }
      // the rim's moving light: ~30 redraws a second, only while the panel is open with a rim
      if (rimWanted() && A.refract > 0 && !hud.classList.contains('collapsed') && now - lastRimDraw > 32){
        if (canAnimate() && A.shineSpin > 0) shineAng += dt / 1000 * (A.shineSpin / 100) * 1.6;
        drawRim(false);
      }
      raf = requestAnimationFrame(meterLoop);
    }
    raf = requestAnimationFrame(meterLoop);

    /* rim highlight follows the pointer, at most once per frame */
    var ptr = null;
    panel.addEventListener('pointermove', function(e){
      var firstEv = !ptr; ptr = e;
      if (firstEv) requestAnimationFrame(function(){ var r=panel.getBoundingClientRect();
        panel.style.setProperty('--mx',(ptr.clientX-r.left)+'px'); panel.style.setProperty('--my',(ptr.clientY-r.top)+'px'); ptr = null; });
    });
    if (window.matchMedia) matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', apply);

    apply();
    return {
      el: hud, panel: panel,
      setState: function(p){ if (!p || !p.banks) return; P = p; render(false); },
      setAppearance: function(a){ A = normalize(a); apply(); render(true); },
      getAppearance: function(){ return clone(A); },
      setRimSource: function(src, rect){ rimSrc = src; rimRect = rect; drawRim(true); },
      clearRim: function(){ rimSrc = null; drawRim(false); },
      redrawRim: function(){ drawRim(false); },
      state: function(){ return P; },
      cardPick: function(i){ return cards[i] && cards[i].el.querySelector('.pickable'); },
      destroy: function(){ alive = false; cancelAnimationFrame(raf); root.innerHTML = ''; }
    };
  }

  window.MixerHud = {create:create, THEMES:THEMES, STYLES:STYLES, FONTS:FONTS, DEFAULTS:DEFAULTS, MUTE_DEFAULT:MUTE_DEFAULT,
    normalize:normalize, themeOf:themeOf, tintRgb:tintRgb, accentRgb:accentRgb, accentHex:accentHex, tileFor:tileFor, brandBase:brandBase,
    fontCss:fontCss, loadFont:loadFont, isSystemReduced:isSystemReduced, rgbStr:rgbStr, rgbHex:rgbHex, hexRgb:hexRgb};
})();
