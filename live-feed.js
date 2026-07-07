'use strict';
// ============================================================
//  live-feed.js  -  Real-Time Activity Feed for MRF SMS
// ============================================================
//  SETUP: Add ONE line anywhere in server.js (before listen):
//
//    require('./live-feed')(app, pool);
//
//  Then in your dashboard HTML, before </body> add:
//    <script src="/api/live-feed/widget.js"></script>
//
//  Full page also available at:  https://yoursite.com/live
// ============================================================

// WhatsApp SVG icon
var WA_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 175.216 175.552">' +
'<defs><linearGradient id="b" x1="85.915" x2="86.535" y1="32.567" y2="137.092" gradientUnits="userSpaceOnUse">' +
'<stop offset="0" stop-color="#57d163"/><stop offset="1" stop-color="#23b33a"/></linearGradient>' +
'<linearGradient id="a" x1="85.915" x2="86.535" y1="32.567" y2="137.092" gradientUnits="userSpaceOnUse">' +
'<stop offset="0" stop-color="#57d163"/><stop offset="1" stop-color="#23b33a"/></linearGradient></defs>' +
'<path fill="#b3b3b3" d="M87.184 25.227c-33.733 0-61.166 27.423-61.178 61.13a60.98 60.98 0 0 0 9.349 32.535L26 139.021l21.075-5.522a61.05 61.05 0 0 0 29.129 7.399h.026c33.73 0 61.162-27.423 61.174-61.13 0-16.335-6.355-31.666-17.896-43.236a60.971 60.971 0 0 0-43.324-18.305z"/>' +
'<path fill="url(#a)" d="M87.184 32.235c-29.942 0-54.3 24.354-54.306 54.27a53.927 53.927 0 0 0 9.344 30.01L35.15 133.53l17.679-4.641a54.07 54.07 0 0 0 34.355 12.32c29.94 0 54.3-24.354 54.306-54.27a54.07 54.07 0 0 0-54.306-54.304z"/>' +
'<path fill="#fff" fill-rule="evenodd" d="M68.772 55.603c-1.378-3.061-2.828-3.123-4.137-3.176l-3.524-.043c-1.226 0-3.218.46-4.902 2.3s-6.435 6.287-6.435 15.332 6.588 17.785 7.506 19.013 12.718 20.381 31.405 27.75c15.529 6.124 18.689 4.906 22.061 4.6s10.877-4.447 12.408-8.74 1.532-7.971 1.073-8.74-1.685-1.226-3.524-2.146-10.877-5.367-12.562-5.981-2.91-.919-4.137.921-4.746 5.979-5.819 7.206-2.144 1.381-3.984.462-7.76-2.861-14.784-9.124c-5.465-4.873-9.154-10.891-10.228-12.73s-.114-2.835.808-3.751c.825-.824 1.838-2.147 2.759-3.22s1.224-1.84 1.836-3.065.307-2.301-.153-3.22-4.032-10.011-5.669-13.645z"/>' +
'</svg>';

module.exports = function setupLiveFeed(app, pool) {

    /* ----------------------------------------------------------
       Serve WhatsApp SVG icon
    ---------------------------------------------------------- */
    app.get('/api/live-feed/wa-icon', function(req, res) {
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(WA_SVG);
    });

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
                return {
                    name:    formatName(r.username_snapshot),
                    country: String(r.country || 'Unknown'),
                    service: formatService(r.service_name),
                    phone:   maskPhone(r.phone_number),
                    price:   Math.round(Number(r.price || 0)),
                    ago:     timeAgo(r.created_at)
                };
            });

            res.json({ orders: orders });
        } catch (err) {
            res.status(500).json({ orders: [] });
        }
    });

    /* ----------------------------------------------------------
       Widget JS — embed in any page with:
         <script src="/api/live-feed/widget.js"></script>
    ---------------------------------------------------------- */
    app.get('/api/live-feed/widget.js', function(req, res) {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store, no-cache');
        res.send(buildWidgetJs());
    });

    /* ----------------------------------------------------------
       Full standalone page at /live
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
    return String(sn || 'Service')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, function(c) { return c.toUpperCase(); });
}

function timeAgo(dateStr) {
    var diff = Math.max(0, Date.now() - new Date(dateStr).getTime());
    var s = Math.floor(diff / 1000);
    if (s < 60)  return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60)  return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24)  return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
}

/* ----------------------------------------------------------
   Widget JS (injected into any page)
   - Adds a floating "Live" button (bottom-right)
   - On click: opens a small popup on the right side
   - Auto-refreshes every 5 seconds while open
---------------------------------------------------------- */
function buildWidgetJs() {
    return `(function(){
  if(document.getElementById('mrf-live-widget'))return;

  /* ---------- CSS ---------- */
  var style=document.createElement('style');
  style.textContent=
    '#mrf-live-btn{position:fixed;bottom:24px;right:24px;z-index:99998;'+
    'display:flex;align-items:center;gap:7px;background:#16a34a;color:#fff;'+
    'border:none;padding:9px 18px 9px 13px;border-radius:999px;cursor:pointer;'+
    'font-size:13px;font-weight:700;box-shadow:0 4px 18px rgba(0,0,0,.35);'+
    'letter-spacing:.04em;font-family:inherit;}'+
    '#mrf-live-btn .ld{width:8px;height:8px;background:#fff;border-radius:50%;'+
    'animation:mrfpulse 1.3s infinite;}'+
    '@keyframes mrfpulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(1.5)}}'+

    '#mrf-live-popup{position:fixed;bottom:75px;right:24px;z-index:99999;'+
    'width:330px;max-height:480px;background:#1e293b;border:1px solid #334155;'+
    'border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,.55);'+
    'display:none;flex-direction:column;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}'+

    '#mrf-live-popup.open{display:flex;}'+

    '.mrf-phdr{background:#0f172a;padding:11px 14px;display:flex;align-items:center;gap:8px;border-bottom:1px solid #334155;flex-shrink:0;}'+
    '.mrf-phdr-logo{font-size:14px;font-weight:800;color:#fff;}'+
    '.mrf-phdr-sub{font-size:11px;color:#64748b;margin-left:2px;}'+
    '.mrf-plive{display:flex;align-items:center;gap:4px;background:#dc2626;color:#fff;'+
    'padding:3px 9px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:.08em;margin-left:auto;}'+
    '.mrf-pld{width:6px;height:6px;background:#fff;border-radius:50%;animation:mrfpulse 1.3s infinite;}'+

    '.mrf-pclose{background:none;border:none;color:#64748b;cursor:pointer;font-size:18px;'+
    'line-height:1;padding:0 0 0 8px;margin-left:4px;flex-shrink:0;}'+
    '.mrf-pclose:hover{color:#fff;}'+

    '.mrf-pbody{overflow-y:auto;flex:1;padding:10px 10px 6px;}'+

    '.mrf-item{background:#0f172a;border:1px solid #1e293b;border-radius:10px;'+
    'padding:10px 12px;margin-bottom:7px;display:flex;align-items:center;gap:10px;'+
    'animation:mrfsi .3s ease;}'+
    '@keyframes mrfsi{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}'+

    '.mrf-av{width:38px;height:38px;border-radius:50%;background:#075e54;'+
    'display:flex;align-items:center;justify-content:center;flex-shrink:0;padding:8px;}'+
    '.mrf-av img{width:100%;height:100%;object-fit:contain;}'+

    '.mrf-info{flex:1;min-width:0;}'+
    '.mrf-irow{font-size:12.5px;color:#cbd5e1;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'+
    '.mrf-irow strong{color:#f1f5f9;}'+
    '.mrf-stag{display:inline-block;background:#1e3a5f;color:#7dd3fc;font-size:10px;'+
    'padding:1px 6px;border-radius:4px;margin-left:4px;vertical-align:middle;white-space:nowrap;}'+

    '.mrf-btmrow{display:flex;align-items:center;gap:5px;margin-top:4px;}'+
    '.mrf-phtag{background:#0d3b31;color:#6ee7b7;font-size:11px;padding:2px 7px;'+
    'border-radius:4px;font-family:monospace;letter-spacing:.05em;}'+
    '.mrf-otptag{background:#14532d;color:#4ade80;font-size:10px;font-weight:700;'+
    'padding:2px 6px;border-radius:4px;white-space:nowrap;}'+

    '.mrf-pr{text-align:right;flex-shrink:0;}'+
    '.mrf-pramt{font-size:14px;font-weight:700;color:#34d399;}'+
    '.mrf-pramt small{font-size:10px;font-weight:400;}'+
    '.mrf-prago{font-size:10px;color:#475569;margin-top:2px;}'+

    '.mrf-empty{text-align:center;padding:30px 10px;color:#475569;font-size:13px;}'+
    '.mrf-pfooter{text-align:center;font-size:11px;color:#334155;padding:7px;flex-shrink:0;border-top:1px solid #1e293b;}';
  document.head.appendChild(style);

  /* ---------- Floating button ---------- */
  var btn=document.createElement('button');
  btn.id='mrf-live-btn';
  btn.innerHTML='<div class="ld"></div> Live';
  document.body.appendChild(btn);

  /* ---------- Popup ---------- */
  var popup=document.createElement('div');
  popup.id='mrf-live-popup';
  popup.innerHTML=
    '<div class="mrf-phdr">'+
      '<span class="mrf-phdr-logo">MRF SMS</span>'+
      '<span class="mrf-phdr-sub">Live Activity</span>'+
      '<div class="mrf-plive"><div class="mrf-pld"></div> LIVE</div>'+
      '<button class="mrf-pclose" id="mrf-pclose-btn">&times;</button>'+
    '</div>'+
    '<div class="mrf-pbody" id="mrf-pbody"><div class="mrf-empty">Loading...</div></div>'+
    '<div class="mrf-pfooter">Auto-refreshes every 5s</div>';
  document.body.appendChild(popup);

  /* ---------- Toggle ---------- */
  var timer=null;
  function openPopup(){
    popup.classList.add('open');
    loadFeed();
    timer=setInterval(loadFeed,5000);
  }
  function closePopup(){
    popup.classList.remove('open');
    if(timer){clearInterval(timer);timer=null;}
  }

  btn.addEventListener('click',function(){
    if(popup.classList.contains('open')){closePopup();}else{openPopup();}
  });
  document.getElementById('mrf-pclose-btn').addEventListener('click',function(e){
    e.stopPropagation();
    closePopup();
  });

  /* ---------- Fetch & render ---------- */
  function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function loadFeed(){
    fetch('/api/live-feed')
      .then(function(r){return r.json();})
      .then(renderFeed)
      .catch(function(){});
  }
  function renderFeed(data){
    var body=document.getElementById('mrf-pbody');
    if(!data.orders||data.orders.length===0){
      body.innerHTML='<div class="mrf-empty">No verified orders yet.</div>';
      return;
    }
    var html='';
    for(var i=0;i<data.orders.length;i++){
      var o=data.orders[i];
      html+='<div class="mrf-item">';
      html+='<div class="mrf-av"><img src="/api/live-feed/wa-icon" alt="WhatsApp"/></div>';
      html+='<div class="mrf-info">';
      html+='<div class="mrf-irow"><strong>'+esc(o.name)+'</strong> got '+esc(o.country)+'<span class="mrf-stag">'+esc(o.service)+'</span></div>';
      html+='<div class="mrf-btmrow">';
      html+='<span class="mrf-phtag">'+esc(o.phone)+'</span>';
      html+='<span class="mrf-otptag">&#10003; OTP Success</span>';
      html+='</div>';
      html+='</div>';
      html+='<div class="mrf-pr">';
      html+='<div class="mrf-pramt">'+o.price+' <small>PKR</small></div>';
      html+='<div class="mrf-prago">'+esc(o.ago)+'</div>';
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
'.hdr-logo{font-size:17px;font-weight:800;color:#fff;letter-spacing:-.3px}\n' +
'.hdr-sub{font-size:12px;color:#64748b;margin-left:4px}\n' +
'.live-pill{margin-left:auto;display:flex;align-items:center;gap:5px;background:#dc2626;color:#fff;padding:4px 11px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.08em}\n' +
'.live-dot{width:7px;height:7px;background:#fff;border-radius:50%;animation:pulse 1.3s infinite}\n' +
'@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(1.5)}}\n' +
'.wrap{max-width:620px;margin:0 auto;padding:14px 12px}\n' +
'.item{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:13px 15px;margin-bottom:9px;display:flex;align-items:center;gap:13px;animation:si .3s ease}\n' +
'@keyframes si{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}\n' +
'.av{width:44px;height:44px;border-radius:50%;background:#075e54;display:flex;align-items:center;justify-content:center;flex-shrink:0;padding:9px}\n' +
'.av img{width:100%;height:100%;object-fit:contain}\n' +
'.info{flex:1;min-width:0}\n' +
'.irow{font-size:13.5px;color:#cbd5e1;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n' +
'.irow strong{color:#f1f5f9}\n' +
'.stag{display:inline-block;background:#1e3a5f;color:#7dd3fc;font-size:11px;padding:1px 7px;border-radius:4px;margin-left:5px;vertical-align:middle;white-space:nowrap}\n' +
'.btmrow{display:flex;align-items:center;gap:6px;margin-top:5px}\n' +
'.phtag{background:#0d3b31;color:#6ee7b7;font-size:12px;padding:2px 8px;border-radius:5px;font-family:monospace;letter-spacing:.05em}\n' +
'.otptag{background:#14532d;color:#4ade80;font-size:11px;font-weight:700;padding:2px 7px;border-radius:5px;white-space:nowrap}\n' +
'.pr{text-align:right;flex-shrink:0}\n' +
'.pr-amt{font-size:15px;font-weight:700;color:#34d399}\n' +
'.pr-amt small{font-size:11px;font-weight:400}\n' +
'.pr-ago{font-size:11px;color:#475569;margin-top:3px}\n' +
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
'  <div class="footer">Auto-refreshes every <b>5 seconds</b> &nbsp;|&nbsp; OTP Verified Orders Only</div>\n' +
'</div>\n' +
'<script>\n' +
'function esc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}\n' +
'function render(data){\n' +
'  var feed=document.getElementById("feed");\n' +
'  if(!data.orders||data.orders.length===0){\n' +
'    feed.innerHTML=\'<div class="empty">No verified orders yet.</div>\';\n' +
'    return;\n' +
'  }\n' +
'  var html="";\n' +
'  for(var i=0;i<data.orders.length;i++){\n' +
'    var o=data.orders[i];\n' +
'    html+=\'<div class="item">\';\n' +
'    html+=\'<div class="av"><img src="/api/live-feed/wa-icon" alt="WhatsApp"/></div>\';\n' +
'    html+=\'<div class="info">\';\n' +
'    html+=\'<div class="irow"><strong>\'+esc(o.name)+\'</strong> got \'+esc(o.country)+\'<span class="stag">\'+esc(o.service)+\'</span></div>\';\n' +
'    html+=\'<div class="btmrow">\';\n' +
'    html+=\'<span class="phtag">\'+esc(o.phone)+\'</span>\';\n' +
'    html+=\'<span class="otptag">&#10003; OTP Success</span>\';\n' +
'    html+=\'</div>\';\n' +
'    html+=\'</div>\';\n' +
'    html+=\'<div class="pr">\';\n' +
'    html+=\'<div class="pr-amt">\'+o.price+\' <small>PKR</small></div>\';\n' +
'    html+=\'<div class="pr-ago">\'+esc(o.ago)+\'</div>\';\n' +
'    html+=\'</div>\';\n' +
'    html+=\'</div>\';\n' +
'  }\n' +
'  feed.innerHTML=html;\n' +
'}\n' +
'function load(){\n' +
'  fetch("/api/live-feed")\n' +
'    .then(function(r){return r.json();})\n' +
'    .then(render)\n' +
'    .catch(function(){});\n' +
'}\n' +
'load();\n' +
'setInterval(load,5000);\n' +
'</script>\n' +
'</body>\n' +
'</html>';
}
