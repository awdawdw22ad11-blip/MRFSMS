'use strict';
// ============================================================
//  live-feed.js  -  Real-Time Activity Feed for MRF SMS
// ============================================================
//  SETUP: Add ONE line anywhere in server.js (before listen):
//
//    require('./live-feed')(app, pool);
//
//  Then visit:  https://yoursite.com/live
// ============================================================

module.exports = function setupLiveFeed(app, pool) {

    /* ----------------------------------------------------------
       API endpoint  -  returns recent orders as JSON
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
                  AND created_at >= NOW() - INTERVAL '24 hours'
                ORDER BY created_at DESC
                LIMIT 40
            `);

            const statsRes = await pool.query(`
                SELECT COUNT(*) AS total
                FROM orders
                WHERE phone_number IS NOT NULL
                  AND phone_number != ''
                  AND created_at >= NOW() - INTERVAL '24 hours'
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

            res.json({
                orders:   orders,
                total24h: Number(statsRes.rows[0].total || 0)
            });
        } catch (err) {
            res.status(500).json({ orders: [], total24h: 0 });
        }
    });

    /* ----------------------------------------------------------
       HTML page  -  full live feed UI
    ---------------------------------------------------------- */
    app.get('/live', function(req, res) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store, no-cache');
        res.send(buildHtml());
    });
};

/* ----------------------------------------------------------
   Helper functions (server-side)
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
   HTML builder  -  returns the full page as a string
---------------------------------------------------------- */
function buildHtml() {
    return '<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'<meta charset="UTF-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
'<title>Live Orders - MRF SMS</title>\n' +
'<style>\n' +
'*{box-sizing:border-box;margin:0;padding:0}\n' +
'body{background:#0f172a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh}\n' +

/* header */
'.hdr{background:#1e293b;border-bottom:1px solid #334155;padding:14px 20px;display:flex;align-items:center;gap:10px;position:sticky;top:0;z-index:10}\n' +
'.hdr-logo{font-size:17px;font-weight:800;color:#fff;letter-spacing:-.3px}\n' +
'.hdr-sub{font-size:12px;color:#64748b;margin-left:4px}\n' +
'.live-pill{margin-left:auto;display:flex;align-items:center;gap:5px;background:#dc2626;color:#fff;padding:4px 11px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.08em}\n' +
'.live-dot{width:7px;height:7px;background:#fff;border-radius:50%;animation:pulse 1.3s infinite}\n' +
'@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(1.5)}}\n' +

/* stats bar */
'.stats{background:#1e293b;border-bottom:1px solid #334155;padding:8px 20px;font-size:13px;color:#64748b}\n' +
'.stats b{color:#34d399}\n' +

/* feed */
'.wrap{max-width:620px;margin:0 auto;padding:14px 12px}\n' +
'.item{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:13px 15px;margin-bottom:9px;display:flex;align-items:center;gap:13px;animation:si .3s ease}\n' +
'@keyframes si{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}\n' +
'.av{width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:700;color:#fff;flex-shrink:0}\n' +
'.info{flex:1;min-width:0}\n' +
'.irow{font-size:13.5px;color:#cbd5e1;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n' +
'.irow strong{color:#f1f5f9}\n' +
'.stag{display:inline-block;background:#1e3a5f;color:#7dd3fc;font-size:11px;padding:1px 7px;border-radius:4px;margin-left:5px;vertical-align:middle;white-space:nowrap}\n' +
'.phtag{display:inline-block;background:#0d3b31;color:#6ee7b7;font-size:12px;padding:2px 8px;border-radius:5px;margin-top:5px;font-family:monospace;letter-spacing:.05em}\n' +
'.pr{text-align:right;flex-shrink:0}\n' +
'.pr-amt{font-size:15px;font-weight:700;color:#34d399}\n' +
'.pr-amt small{font-size:11px;font-weight:400}\n' +
'.pr-ago{font-size:11px;color:#475569;margin-top:3px}\n' +

/* empty / footer */
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

'<div class="stats" id="statsBar">Loading...</div>\n' +

'<div class="wrap">\n' +
'  <div id="feed"><div class="empty">Loading orders...</div></div>\n' +
'  <div class="footer">Auto-refreshes every <b>5 seconds</b> &nbsp;|&nbsp; Last 24 hours</div>\n' +
'</div>\n' +

'<script>\n' +
'var COLORS=[\n' +
'  "linear-gradient(135deg,#6366f1,#8b5cf6)",\n' +
'  "linear-gradient(135deg,#f59e0b,#ef4444)",\n' +
'  "linear-gradient(135deg,#10b981,#06b6d4)",\n' +
'  "linear-gradient(135deg,#ec4899,#8b5cf6)",\n' +
'  "linear-gradient(135deg,#3b82f6,#06b6d4)",\n' +
'  "linear-gradient(135deg,#f97316,#ef4444)"\n' +
'];\n' +
'function avColor(n){var h=0;for(var i=0;i<n.length;i++)h=(h*31+n.charCodeAt(i))&0xffff;return COLORS[h%COLORS.length];}\n' +
'function esc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}\n' +

'function render(data){\n' +
'  var sb=document.getElementById("statsBar");\n' +
'  sb.innerHTML="Numbers issued in last 24 hours: <b>"+data.total24h+"</b>";\n' +
'  var feed=document.getElementById("feed");\n' +
'  if(!data.orders||data.orders.length===0){\n' +
'    feed.innerHTML=\'<div class="empty">No orders in the last 24 hours yet.</div>\';\n' +
'    return;\n' +
'  }\n' +
'  var html="";\n' +
'  for(var i=0;i<data.orders.length;i++){\n' +
'    var o=data.orders[i];\n' +
'    var init=o.name.charAt(0).toUpperCase();\n' +
'    html+=\'<div class="item">\';\n' +
'    html+=\'<div class="av" style="background:\'+avColor(o.name)+\'">\'+init+\'</div>\';\n' +
'    html+=\'<div class="info">\';\n' +
'    html+=\'<div class="irow"><strong>\'+esc(o.name)+\'</strong> got \'+esc(o.country)+\'<span class="stag">\'+esc(o.service)+\'</span></div>\';\n' +
'    html+=\'<div class="phtag">\'+esc(o.phone)+\'</div>\';\n' +
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
