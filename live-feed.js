'use strict';
// ============================================================
//  live-feed.js  -  Real-Time Activity Feed for MRF SMS
// ============================================================
//  SETUP: Add ONE line in server.js (before listen):
//    require('./live-feed')(app, pool);
//
//  Then in your dashboard HTML, before </body> add:
//    <script src="/api/live-feed/widget.js"></script>
//
//  Full page: https://yoursite.com/live
// ============================================================

// WhatsApp SVG
var WA_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 175.216 175.552">' +
'<defs><linearGradient id="a" x1="85.915" x2="86.535" y1="32.567" y2="137.092" gradientUnits="userSpaceOnUse">' +
'<stop offset="0" stop-color="#57d163"/><stop offset="1" stop-color="#23b33a"/></linearGradient></defs>' +
'<path fill="#b3b3b3" d="M87.184 25.227c-33.733 0-61.166 27.423-61.178 61.13a60.98 60.98 0 0 0 9.349 32.535L26 139.021l21.075-5.522a61.05 61.05 0 0 0 29.129 7.399h.026c33.73 0 61.162-27.423 61.174-61.13 0-16.335-6.355-31.666-17.896-43.236a60.971 60.971 0 0 0-43.324-18.305z"/>' +
'<path fill="url(#a)" d="M87.184 32.235c-29.942 0-54.3 24.354-54.306 54.27a53.927 53.927 0 0 0 9.344 30.01L35.15 133.53l17.679-4.641a54.07 54.07 0 0 0 34.355 12.32c29.94 0 54.3-24.354 54.306-54.27a54.07 54.07 0 0 0-54.306-54.304z"/>' +
'<path fill="#fff" fill-rule="evenodd" d="M68.772 55.603c-1.378-3.061-2.828-3.123-4.137-3.176l-3.524-.043c-1.226 0-3.218.46-4.902 2.3s-6.435 6.287-6.435 15.332 6.588 17.785 7.506 19.013 12.718 20.381 31.405 27.75c15.529 6.124 18.689 4.906 22.061 4.6s10.877-4.447 12.408-8.74 1.532-7.971 1.073-8.74-1.685-1.226-3.524-2.146-10.877-5.367-12.562-5.981-2.91-.919-4.137.921-4.746 5.979-5.819 7.206-2.144 1.381-3.984.462-7.76-2.861-14.784-9.124c-5.465-4.873-9.154-10.891-10.228-12.73s-.114-2.835.808-3.751c.825-.824 1.838-2.147 2.759-3.22s1.224-1.84 1.836-3.065.307-2.301-.153-3.22-4.032-10.011-5.669-13.645z"/>' +
'</svg>';

// Telegram SVG
var TG_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240">' +
'<circle cx="120" cy="120" r="120" fill="url(#tg)"/>' +
'<defs><linearGradient id="tg" x1="120" y1="0" x2="120" y2="240" gradientUnits="userSpaceOnUse">' +
'<stop offset="0" stop-color="#2aabee"/><stop offset="1" stop-color="#229ed9"/></linearGradient></defs>' +
'<path fill="#fff" d="M81.5 130.2l-5.2 29.6c0 0 -.7 5.4 4.7 5.4 5.4 0 7.9-5.2 7.9-5.2l15.6-14.7 28.7 21.4c5.3 2.9 9.1.7 10.3-4.9l18.6-87.6c1.7-6.8-2.6-9.6-7.3-7.5l-107 41.2c-6.5 2.6-6.4 6.3-.9 8l27.4 8.6 63.6-40.1c3-1.8 5.8-.8 3.5 1.2L81.5 130.2z"/>' +
'</svg>';

// Generic phone SVG
var PHONE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
'<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 2.18h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9.91a16 16 0 0 0 6.06 6.06l.94-.94a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7a2 2 0 0 1 1.72 2.03z"/>' +
'</svg>';

module.exports = function setupLiveFeed(app, pool) {

    /* ----------------------------------------------------------
       Serve platform icons
    ---------------------------------------------------------- */
    app.get('/api/live-feed/wa-icon',   function(req, res) { res.setHeader('Content-Type','image/svg+xml'); res.setHeader('Cache-Control','public,max-age=86400'); res.send(WA_SVG); });
    app.get('/api/live-feed/tg-icon',   function(req, res) { res.setHeader('Content-Type','image/svg+xml'); res.setHeader('Cache-Control','public,max-age=86400'); res.send(TG_SVG); });
    app.get('/api/live-feed/ph-icon',   function(req, res) { res.setHeader('Content-Type','image/svg+xml'); res.setHeader('Cache-Control','public,max-age=86400'); res.send(PHONE_SVG); });

    /* ----------------------------------------------------------
       API: only OTP-successful / completed orders
    ---------------------------------------------------------- */
    app.get('/api/live-feed', async (req, res) => {
        try {
            const ordersRes = await pool.query(`
                SELECT
                    username_snapshot,
                    country,
                    service_name,
                    phone_number,
                    price,
                    created_at
                FROM orders
                WHERE phone_number IS NOT NULL
                  AND phone_number != ''
                  AND (
                      otp_received = TRUE
                      OR LOWER(COALESCE(status, order_status, '')) = 'completed'
                  )
                ORDER BY created_at DESC
                LIMIT 40
            `);

            const orders = ordersRes.rows.map(function(r) {
                var sn = String(r.service_name || '').toLowerCase();
                var platform = 'other';
                if (sn.indexOf('whatsapp') !== -1 || sn.indexOf('wa') !== -1) platform = 'whatsapp';
                else if (sn.indexOf('telegram') !== -1 || sn.indexOf('tg') !== -1) platform = 'telegram';

                return {
                    name:     formatName(r.username_snapshot),
                    country:  String(r.country || 'Unknown'),
                    service:  formatService(r.service_name),
                    platform: platform,
                    phone:    maskPhone(r.phone_number),
                    price:    Math.round(Number(r.price || 0)),
                    ago:      timeAgo(r.created_at)
                };
            });

            res.json({ orders: orders });
        } catch (err) {
            res.status(500).json({ orders: [] });
        }
    });

    /* ----------------------------------------------------------
       Widget JS — embed with: <script src="/api/live-feed/widget.js"></script>
    ---------------------------------------------------------- */
    app.get('/api/live-feed/widget.js', function(req, res) {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store, no-cache');
        res.send(buildWidgetJs());
    });

    /* ----------------------------------------------------------
       Full page at /live
    ---------------------------------------------------------- */
    app.get('/live', function(req, res) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store, no-cache');
        res.send(buildFullPageHtml());
    });
};

/* ----------------------------------------------------------
   Server-side helpers
---------------------------------------------------------- */
function maskPhone(phone) {
    var s = String(phone || '').replace(/\s/g, '');
    if (s.length < 5) return s + '***';
    var show = Math.min(7, Math.ceil(s.length * 0.52));
    return s.slice(0, show) + '*'.repeat(s.length - show);
}
function formatName(u) {
    var s = String(u || 'User').trim();
    var first = (s.split(/\s+/)[0]) || 'User';
    return first.charAt(0).toUpperCase() + first.slice(1);
}
function formatService(sn) {
    return String(sn || 'Service').replace(/_/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
}
function timeAgo(dateStr) {
    var diff = Math.max(0, Date.now() - new Date(dateStr).getTime());
    var s = Math.floor(diff / 1000);
    if (s < 60)  return s + ' sec ago';
    var m = Math.floor(s / 60);
    if (m < 60)  return m + ' min ago';
    var h = Math.floor(m / 60);
    if (h < 24)  return h + ' hr ago';
    return Math.floor(h / 24) + ' days ago';
}

/* ----------------------------------------------------------
   Widget JS
   - Floating "Live" button on BOTTOM-LEFT
   - Click opens popup on LEFT side
   - Shows correct platform icon per order
   - Time clearly visible on its own line
---------------------------------------------------------- */
function buildWidgetJs() {
    return `(function(){
  if(document.getElementById('mrf-live-widget-root'))return;
  var root=document.createElement('div');
  root.id='mrf-live-widget-root';
  document.body.appendChild(root);

  /* ---- CSS ---- */
  var st=document.createElement('style');
  st.textContent=
    /* Floating button - BOTTOM LEFT */
    '#mrflbtn{position:fixed;bottom:16px;right:16px;z-index:99998;'+
    'display:flex;align-items:center;gap:7px;background:#16a34a;color:#fff;'+
    'border:none;padding:10px 18px 10px 13px;border-radius:999px;cursor:pointer;'+
    'font-size:14px;font-weight:700;box-shadow:0 4px 18px rgba(0,0,0,.4);'+
    'letter-spacing:.04em;font-family:inherit;transition:background .2s;touch-action:manipulation;}'+
    '#mrflbtn:hover{background:#15803d;}'+
    '#mrflbtn .ld{width:8px;height:8px;background:#fff;border-radius:50%;animation:mrfp 1.3s infinite;}'+
    '@keyframes mrfp{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(1.6)}}'+

    /* Popup - mobile responsive */
    '#mrflpop{position:fixed;bottom:70px;right:10px;z-index:99999;'+
    'width:min(340px,calc(100vw - 20px));max-height:min(490px,calc(100vh - 90px));'+
    'background:#1e293b;border:1px solid #334155;'+
    'border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.6);'+
    'display:none;flex-direction:column;overflow:hidden;'+
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}'+
    '#mrflpop.open{display:flex;}'+

    /* Header */
    '.mrfhdr{background:#0f172a;padding:11px 14px;display:flex;align-items:center;'+
    'gap:8px;border-bottom:1px solid #334155;flex-shrink:0;}'+
    '.mrfhdr-logo{font-size:14px;font-weight:800;color:#fff;}'+
    '.mrfhdr-sub{font-size:11px;color:#64748b;margin-left:3px;}'+
    '.mrflive-pill{display:flex;align-items:center;gap:4px;background:#dc2626;color:#fff;'+
    'padding:3px 9px;border-radius:999px;font-size:10px;font-weight:700;'+
    'letter-spacing:.08em;margin-left:auto;}'+
    '.mrflive-dot{width:6px;height:6px;background:#fff;border-radius:50%;animation:mrfp 1.3s infinite;}'+
    '.mrfclose{background:none;border:none;color:#64748b;cursor:pointer;'+
    'font-size:20px;line-height:1;padding:0 0 0 8px;flex-shrink:0;}'+
    '.mrfclose:hover{color:#f1f5f9;}'+

    /* Scroll body */
    '.mrfbody{overflow-y:auto;flex:1;padding:8px;}'+

    /* Each order card */
    '.mrfcard{background:#0f172a;border:1px solid #1e293b;border-radius:10px;'+
    'padding:10px 11px;margin-bottom:7px;display:flex;align-items:center;gap:10px;'+
    'animation:mrfin .3s ease;}'+
    '@keyframes mrfin{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}'+

    /* Avatar circle */
    '.mrfav{width:40px;height:40px;min-width:40px;border-radius:50%;'+
    'display:flex;align-items:center;justify-content:center;padding:8px;flex-shrink:0;}'+
    '.mrfav img{width:100%;height:100%;object-fit:contain;display:block;}'+
    '.mrfav.wa{background:#075e54;}'+
    '.mrfav.tg{background:#0088cc;}'+
    '.mrfav.ph{background:#334155;}'+

    /* Text info */
    '.mrfinfo{flex:1;min-width:0;}'+
    '.mrftitle{font-size:12.5px;color:#cbd5e1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'+
    '.mrftitle strong{color:#f8fafc;}'+
    '.mrfsvc{display:inline-block;background:#1e3a5f;color:#7dd3fc;'+
    'font-size:10px;padding:1px 6px;border-radius:4px;margin-left:4px;vertical-align:middle;}'+
    '.mrfphone{font-family:monospace;font-size:11.5px;color:#6ee7b7;'+
    'background:#0d3b31;padding:2px 7px;border-radius:4px;display:inline-block;margin-top:4px;}'+
    '.mrfotp{display:inline-block;background:#14532d;color:#4ade80;'+
    'font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;margin-top:4px;margin-left:4px;}'+

    /* Price + time on right */
    '.mrfright{text-align:right;flex-shrink:0;min-width:56px;}'+
    '.mrfprice{font-size:13px;font-weight:700;color:#34d399;white-space:nowrap;}'+
    '.mrfprice small{font-size:10px;font-weight:400;color:#86efac;}'+
    '.mrftime{font-size:10.5px;color:#94a3b8;margin-top:4px;white-space:nowrap;}'+

    /* Empty / footer */
    '.mrfempty{text-align:center;padding:30px 10px;color:#475569;font-size:13px;}'+
    '.mrffoot{text-align:center;font-size:10.5px;color:#334155;'+
    'padding:6px;flex-shrink:0;border-top:1px solid #1e293b;}';
  document.head.appendChild(st);

  /* ---- Button ---- */
  var btn=document.createElement('button');
  btn.id='mrflbtn';
  btn.innerHTML='<div class="ld"></div> Live';
  document.body.appendChild(btn);

  /* ---- Popup ---- */
  var pop=document.createElement('div');
  pop.id='mrflpop';
  pop.innerHTML=
    '<div class="mrfhdr">'+
      '<span class="mrfhdr-logo">MRF SMS</span>'+
      '<span class="mrfhdr-sub">Live Activity</span>'+
      '<div class="mrflive-pill"><div class="mrflive-dot"></div> LIVE</div>'+
      '<button class="mrfclose" id="mrfcloseX">&times;</button>'+
    '</div>'+
    '<div class="mrfbody" id="mrfbody"><div class="mrfempty">Loading...</div></div>'+
    '<div class="mrffoot">Auto-refreshes every 5 seconds &bull; OTP Verified Only</div>';
  document.body.appendChild(pop);

  /* ---- Open / Close ---- */
  var tmr=null;
  function open_(){pop.classList.add('open');loadFeed();tmr=setInterval(loadFeed,5000);}
  function close_(){pop.classList.remove('open');if(tmr){clearInterval(tmr);tmr=null;}}

  btn.addEventListener('click',function(){pop.classList.contains('open')?close_():open_();});
  document.getElementById('mrfcloseX').addEventListener('click',function(e){e.stopPropagation();close_();});

  /* ---- Fetch & render ---- */
  function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

  function iconFor(platform){
    if(platform==='whatsapp') return {cls:'wa',src:'/api/live-feed/wa-icon',alt:'WhatsApp'};
    if(platform==='telegram') return {cls:'tg',src:'/api/live-feed/tg-icon',alt:'Telegram'};
    return {cls:'ph',src:'/api/live-feed/ph-icon',alt:'SMS'};
  }

  function loadFeed(){
    fetch('/api/live-feed')
      .then(function(r){return r.json();})
      .then(renderFeed)
      .catch(function(){});
  }

  function renderFeed(data){
    var body=document.getElementById('mrfbody');
    if(!data.orders||data.orders.length===0){
      body.innerHTML='<div class="mrfempty">No verified orders yet.</div>';
      return;
    }
    var html='';
    for(var i=0;i<data.orders.length;i++){
      var o=data.orders[i];
      var ic=iconFor(o.platform);
      html+='<div class="mrfcard">';
      html+='<div class="mrfav '+ic.cls+'"><img src="'+ic.src+'" alt="'+ic.alt+'"/></div>';
      html+='<div class="mrfinfo">';
      html+='<div class="mrftitle"><strong>'+esc(o.name)+'</strong> got '+esc(o.country)+'<span class="mrfsvc">'+esc(o.service)+'</span></div>';
      html+='<span class="mrfphone">'+esc(o.phone)+'</span>';
      html+='<span class="mrfotp">&#10003; OTP Success</span>';
      html+='</div>';
      html+='<div class="mrfright">';
      html+='<div class="mrfprice">'+o.price+' <small>PKR</small></div>';
      html+='<div class="mrftime">'+esc(o.ago)+'</div>';
      html+='</div>';
      html+='</div>';
    }
    body.innerHTML=html;
  }
})();`;
}

/* ----------------------------------------------------------
   Full standalone page at /live
---------------------------------------------------------- */
function buildFullPageHtml() {
    return '<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'<meta charset="UTF-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
'<title>Live Orders - MRF SMS</title>\n' +
'<style>\n' +
'*{box-sizing:border-box;margin:0;padding:0}\n' +
'body{background:#0f172a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh}\n' +
'.hdr{background:#1e293b;border-bottom:1px solid #334155;padding:14px 20px;display:flex;align-items:center;gap:10px;position:sticky;top:0;z-index:10}\n' +
'.hdr-logo{font-size:17px;font-weight:800;color:#fff}\n' +
'.hdr-sub{font-size:12px;color:#64748b;margin-left:4px}\n' +
'.live-pill{margin-left:auto;display:flex;align-items:center;gap:5px;background:#dc2626;color:#fff;padding:4px 11px;border-radius:999px;font-size:11px;font-weight:700}\n' +
'.live-dot{width:7px;height:7px;background:#fff;border-radius:50%;animation:pulse 1.3s infinite}\n' +
'@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(1.5)}}\n' +
'.wrap{max-width:620px;margin:0 auto;padding:14px 12px}\n' +
'.item{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:13px 15px;margin-bottom:9px;display:flex;align-items:center;gap:13px;animation:si .3s ease}\n' +
'@keyframes si{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}\n' +
'.av{width:46px;height:46px;min-width:46px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;padding:9px}\n' +
'.av img{width:100%;height:100%;object-fit:contain}\n' +
'.av.wa{background:#075e54}.av.tg{background:#0088cc}.av.ph{background:#334155}\n' +
'.info{flex:1;min-width:0}\n' +
'.irow{font-size:13.5px;color:#cbd5e1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n' +
'.irow strong{color:#f1f5f9}\n' +
'.stag{display:inline-block;background:#1e3a5f;color:#7dd3fc;font-size:11px;padding:1px 7px;border-radius:4px;margin-left:5px;vertical-align:middle}\n' +
'.btmrow{display:flex;align-items:center;gap:6px;margin-top:5px;flex-wrap:wrap}\n' +
'.phtag{background:#0d3b31;color:#6ee7b7;font-size:12px;padding:2px 8px;border-radius:5px;font-family:monospace}\n' +
'.otptag{background:#14532d;color:#4ade80;font-size:11px;font-weight:700;padding:2px 7px;border-radius:5px}\n' +
'.pr{text-align:right;flex-shrink:0;min-width:70px}\n' +
'.pr-amt{font-size:15px;font-weight:700;color:#34d399;white-space:nowrap}\n' +
'.pr-amt small{font-size:11px;font-weight:400}\n' +
'.pr-ago{font-size:11px;color:#94a3b8;margin-top:4px;white-space:nowrap}\n' +
'.empty{text-align:center;padding:60px 20px;color:#475569}\n' +
'.footer{text-align:center;font-size:12px;color:#334155;padding:12px;margin-top:4px}\n' +
'.footer b{color:#475569}\n' +
'</style>\n' +
'</head>\n' +
'<body>\n' +
'<div class="hdr">\n' +
'  <span class="hdr-logo">MRF SMS</span>\n' +
'  <span class="hdr-sub">Live Activity</span>\n' +
'  <div class="live-pill"><div class="live-dot"></div> LIVE</div>\n' +
'</div>\n' +
'<div class="wrap">\n' +
'  <div id="feed"><div class="empty">Loading...</div></div>\n' +
'  <div class="footer">Auto-refreshes every <b>5 seconds</b> &nbsp;&bull;&nbsp; OTP Verified Orders Only</div>\n' +
'</div>\n' +
'<script>\n' +
'function esc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}\n' +
'function iconFor(p){\n' +
'  if(p==="whatsapp")return{cls:"wa",src:"/api/live-feed/wa-icon",alt:"WhatsApp"};\n' +
'  if(p==="telegram")return{cls:"tg",src:"/api/live-feed/tg-icon",alt:"Telegram"};\n' +
'  return{cls:"ph",src:"/api/live-feed/ph-icon",alt:"SMS"};\n' +
'}\n' +
'function render(data){\n' +
'  var feed=document.getElementById("feed");\n' +
'  if(!data.orders||data.orders.length===0){feed.innerHTML=\'<div class="empty">No verified orders yet.</div>\';return;}\n' +
'  var html="";\n' +
'  for(var i=0;i<data.orders.length;i++){\n' +
'    var o=data.orders[i];var ic=iconFor(o.platform);\n' +
'    html+=\'<div class="item">\';\n' +
'    html+=\'<div class="av \'+ic.cls+\'"><img src="\'+ic.src+\'" alt="\'+ic.alt+\'"/></div>\';\n' +
'    html+=\'<div class="info">\';\n' +
'    html+=\'<div class="irow"><strong>\'+esc(o.name)+\'</strong> got \'+esc(o.country)+\'<span class="stag">\'+esc(o.service)+\'</span></div>\';\n' +
'    html+=\'<div class="btmrow"><span class="phtag">\'+esc(o.phone)+\'</span><span class="otptag">&#10003; OTP Success</span></div>\';\n' +
'    html+=\'</div>\';\n' +
'    html+=\'<div class="pr"><div class="pr-amt">\'+o.price+\' <small>PKR</small></div><div class="pr-ago">\'+esc(o.ago)+\'</div></div>\';\n' +
'    html+=\'</div>\';\n' +
'  }\n' +
'  feed.innerHTML=html;\n' +
'}\n' +
'function load(){fetch("/api/live-feed").then(function(r){return r.json();}).then(render).catch(function(){});}\n' +
'load();setInterval(load,5000);\n' +
'</script>\n' +
'</body>\n' +
'</html>';
}
