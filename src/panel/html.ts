import type { GatewayContext } from "../types.ts";

/**
 * 面板单页：原生 JS + 内联样式，无构建步骤、无前端依赖。
 * 所有请求走 /panel/api?action=xxx，管理员令牌从 URL 的 key 参数取并存入 localStorage。
 */
export function panelHtml(ctx: GatewayContext): string {
  const hasAdmin = !!ctx.cfg.adminToken;
  return "<!doctype html>\n" + PAGE.replace("__HAS_ADMIN__", hasAdmin ? "1" : "0");
}

const PAGE = String.raw`
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude Gateway 面板</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--line:#262b36;--fg:#e6e9ef;--dim:#8b93a7;--acc:#4f8cff;--ok:#3ecf8e;--warn:#f5a524;--bad:#f31260}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
header{display:flex;align-items:center;gap:12px;padding:12px 18px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:10}
header h1{margin:0;font-size:15px;font-weight:600}
header .sp{flex:1}
nav{display:flex;gap:4px;padding:10px 18px;border-bottom:1px solid var(--line);background:var(--panel);flex-wrap:wrap}
nav button{background:transparent;border:1px solid transparent;color:var(--dim);padding:6px 14px;border-radius:7px;cursor:pointer;font-size:13px}
nav button:hover{color:var(--fg);background:#1e222b}
nav button.on{background:var(--acc);border-color:var(--acc);color:#fff}
main{padding:18px;max-width:1400px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}
.card h2{margin:0 0 12px;font-size:14px;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
.stat{background:#12151b;border:1px solid var(--line);border-radius:8px;padding:12px}
.stat .k{color:var(--dim);font-size:12px;margin-bottom:4px}
.stat .v{font-size:20px;font-weight:600}
.stat .v.ok{color:var(--ok)}.stat .v.warn{color:var(--warn)}.stat .v.bad{color:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:500;white-space:nowrap}
tr:hover td{background:#1a1e26}
tr.blocked td{background:rgba(243,18,96,.07)}
tr.blocked:hover td{background:rgba(243,18,96,.13)}
input,select,textarea{background:#0f1218;border:1px solid var(--line);color:var(--fg);border-radius:7px;padding:7px 10px;font-size:13px;font-family:inherit}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--acc)}
textarea{width:100%;min-height:90px;font-family:ui-monospace,Consolas,monospace;font-size:12px}
button.btn{background:var(--acc);border:none;color:#fff;padding:8px 16px;border-radius:7px;cursor:pointer;font-size:13px}
button.btn:hover{filter:brightness(1.1)}
button.btn.ghost{background:#232833;color:var(--fg)}
button.btn.danger{background:#3a1d2a;color:#ff7ba0}
button.btn.sm{padding:4px 10px;font-size:12px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px}
.field{display:flex;flex-direction:column;gap:5px}
.field label{color:var(--dim);font-size:12px}
.pill{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;border:1px solid var(--line)}
.pill.ok{color:var(--ok);border-color:rgba(62,207,142,.35);background:rgba(62,207,142,.1)}
.pill.warn{color:var(--warn);border-color:rgba(245,165,36,.35);background:rgba(245,165,36,.1)}
.pill.bad{color:var(--bad);border-color:rgba(243,18,96,.35);background:rgba(243,18,96,.1)}
.pill.dim{color:var(--dim)}
pre{background:#0f1218;border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;font-size:12px;margin:0}
code{font-family:ui-monospace,Consolas,monospace}
.banner{border-radius:8px;padding:12px 14px;margin-bottom:14px;border:1px solid;display:none}
.banner.show{display:block}
.banner.info{background:rgba(79,140,255,.1);border-color:rgba(79,140,255,.4)}
.banner.err{background:rgba(243,18,96,.1);border-color:rgba(243,18,96,.4)}
.banner .t{font-weight:600;margin-bottom:6px}
.muted{color:var(--dim)}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}
.tiny{font-size:11.5px}
.warnbox{background:rgba(245,165,36,.1);border:1px solid rgba(245,165,36,.4);border-radius:8px;padding:12px;margin-bottom:14px}
.pager{display:flex;gap:8px;align-items:center;margin-top:12px}
</style>
</head>
<body>
<header>
  <h1>Claude Gateway</h1>
  <span id="hdrState" class="muted tiny"></span>
  <span class="sp"></span>
  <button class="btn ghost sm" onclick="refresh()">刷新</button>
</header>
<nav id="nav"></nav>
<main>
  <div id="banner" class="banner"></div>
  <div id="adminWarn"></div>
  <div id="view"></div>
</main>
<script>
var HAS_ADMIN = "__HAS_ADMIN__" === "1";
var KEY = new URLSearchParams(location.search).get("key") || localStorage.getItem("cg_key") || "";
if (KEY) localStorage.setItem("cg_key", KEY);
var TAB = "overview";
var DATA = { accounts: [], keys: [], settings: null, reqPage: 0, rtPage: 0, reqTotal: 0, rtTotal: 0 };
var CREATED_KEY = null;

var TABS = [
  ["overview", "概览"],
  ["accounts", "号池"],
  ["keys", "API Key"],
  ["reqlogs", "请求日志"],
  ["rtlogs", "运行日志"],
  ["settings", "设置"]
];

function esc(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function el(id) { return document.getElementById(id); }
function val(id) { var e = el(id); return e ? e.value : ""; }
function checked(id) { var e = el(id); return e ? !!e.checked : false; }
function num(id) { var v = parseInt(val(id), 10); return isFinite(v) ? v : 0; }
function pad2(n) { return n < 10 ? "0" + n : "" + n; }
function fmtTime(ms) {
  if (!ms) return "-";
  var d = new Date(ms);
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " +
    pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}
function fmtAgo(ms) {
  if (!ms) return "-";
  var s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return s + " 秒前";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  return Math.floor(s / 86400) + " 天前";
}
function fmtNum(n) {
  if (n === null || n === undefined) return "-";
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function banner(kind, title, msg) {
  var b = el("banner");
  b.className = "banner " + kind + " show";
  b.innerHTML = "<div class=\"t\">" + esc(title) + "</div>" + (msg ? "<div>" + esc(msg) + "</div>" : "");
  if (kind === "info") setTimeout(function () { b.className = "banner"; }, 6000);
}
function clearBanner() { el("banner").className = "banner"; }

function api(action, opts) {
  opts = opts || {};
  var url = "/panel/api?action=" + encodeURIComponent(action);
  if (KEY) url += "&key=" + encodeURIComponent(KEY);
  if (opts.params) {
    for (var k in opts.params) {
      if (opts.params[k] !== undefined && opts.params[k] !== null && opts.params[k] !== "") {
        url += "&" + encodeURIComponent(k) + "=" + encodeURIComponent(opts.params[k]);
      }
    }
  }
  return fetch(url, {
    method: opts.method || "GET",
    headers: { "content-type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      if (!r.ok) throw new Error((j.error && j.error.message) || ("HTTP " + r.status));
      return j;
    });
  });
}

function copyText(t) {
  navigator.clipboard.writeText(t).then(function () { banner("info", "已复制到剪贴板"); });
}

function renderNav() {
  var h = "";
  for (var i = 0; i < TABS.length; i++) {
    h += "<button class=\"" + (TAB === TABS[i][0] ? "on" : "") + "\" onclick=\"go('" + TABS[i][0] + "')\">" + TABS[i][1] + "</button>";
  }
  el("nav").innerHTML = h;
}
function go(t) { TAB = t; clearBanner(); renderNav(); refresh(); }

function renderOverview(d) {
  var p = d.pool;
  function stat(k, v, cls) {
    return "<div class=\"stat\"><div class=\"k\">" + esc(k) + "</div><div class=\"v " + (cls || "") + "\">" + esc(v) + "</div></div>";
  }
  var h = "<div class=\"card\"><h2>运行状态</h2><div class=\"grid\">";
  h += stat("号池总数", p.total);
  h += stat("可用账号", p.active, p.active > 0 ? "ok" : "bad");
  h += stat("冷却中", p.cooling, p.cooling > 0 ? "warn" : "");
  h += stat("额度耗尽", p.exhausted, p.exhausted > 0 ? "bad" : "");
  h += stat("已停用", p.disabled, p.disabled > 0 ? "warn" : "");
  h += stat("出错账号", p.errored, p.errored > 0 ? "bad" : "");
  h += stat("会话粘性条目", p.sticky);
  h += stat("API Key 数", d.keys);
  h += stat("今日请求", fmtNum(d.today.requests));
  h += stat("今日 token", fmtNum(d.today.tokens));
  h += "</div></div>";

  h += "<div class=\"card\"><h2>累计统计</h2><div class=\"grid\">";
  h += stat("总请求", fmtNum(d.stats.totalRequests));
  h += stat("被拦截", fmtNum(d.stats.blocked), d.stats.blocked > 0 ? "warn" : "");
  h += stat("错误", fmtNum(d.stats.errors), d.stats.errors > 0 ? "bad" : "");
  h += stat("近 24 小时", fmtNum(d.stats.last24h));
  h += stat("运行日志条数", fmtNum(d.stats.runtimeEntries));
  h += "</div></div>";

  h += "<div class=\"card\"><h2>策略</h2><table><tbody>";
  h += "<tr><th>出口地址</th><td class=\"mono\">" + esc(d.publicUrl || "(未设置 PUBLIC_URL)") + "</td></tr>";
  h += "<tr><th>上游</th><td class=\"mono\">" + esc(d.upstreamBase) + "</td></tr>";
  h += "<tr><th>请求头守卫</th><td>" + esc(d.guardMode) + (d.injectMissing ? "（开启缺失头注入）" : "") + "</td></tr>";
  h += "<tr><th>隐写拦截</th><td>" + esc(d.stegoMode) + "</td></tr>";
  h += "<tr><th>请求 ID 回传</th><td>" + esc(d.reqIdInResponse) + "</td></tr>";
  h += "<tr><th>凭据构成</th><td>OAuth " + p.oauth + " 个 / Console Key " + p.apikey + " 个</td></tr>";
  h += "</tbody></table></div>";

  if (p.exhaustedList && p.exhaustedList.length) {
    h += "<div class=\"card\"><h2>额度耗尽的账号</h2><table><thead><tr><th>账号</th><th>原因</th><th>预计恢复</th><th></th></tr></thead><tbody>";
    for (var e = 0; e < p.exhaustedList.length; e++) {
      var x = p.exhaustedList[e];
      h += "<tr><td>" + esc(x.label) + "</td><td class=\"tiny\">" + esc(x.reason || "-") + "</td>" +
        "<td class=\"tiny\">" + esc(x.until ? fmtTime(x.until * 1000) : "待上游恢复") + "</td>" +
        "<td style=\"white-space:nowrap\"><button class=\"btn sm\" onclick=\"actRevive('" + esc(x.id) + "')\">立即恢复</button> " +
        "<button class=\"btn ghost sm\" onclick=\"actFetchUsage('" + esc(x.id) + "')\">查用量</button></td></tr>";
    }
    h += "</tbody></table></div>";
  }

  if (p.coolingList && p.coolingList.length) {
    h += "<div class=\"card\"><h2>冷却中的账号</h2><table><thead><tr><th>账号</th><th>恢复时间</th><th></th></tr></thead><tbody>";
    for (var i = 0; i < p.coolingList.length; i++) {
      var c = p.coolingList[i];
      h += "<tr><td>" + esc(c.label) + "</td><td>" + esc(fmtTime(c.until * 1000)) + "</td>" +
        "<td><button class=\"btn ghost sm\" onclick=\"actReset('" + esc(c.id) + "')\">解除冷却</button></td></tr>";
    }
    h += "</tbody></table></div>";
  }
  return h;
}

function pct(v) {
  if (v === null || v === undefined) return null;
  return Math.round(v * 1000) / 10;
}
function usageBar(w) {
  var p = pct(w.utilization);
  if (p === null) return "";
  var cls = w.status === "rejected" ? "bad" : (p >= 80 ? "warn" : "ok");
  var wd = Math.max(0, Math.min(100, p));
  return "<div style=\"margin:2px 0\"><span class=\"tiny\">" + p + "%</span>" +
    "<div style=\"height:4px;background:#232833;border-radius:3px;overflow:hidden;margin-top:2px\">" +
    "<div style=\"height:100%;width:" + wd + "%;background:var(--" + cls + ")\"></div></div></div>";
}
function usageCell(a) {
  var u = a.usage || { windows: {} };
  var keys = Object.keys(u.windows || {});
  if (!keys.length) {
    return u.error ? "<span class=\"tiny muted\">查询失败</span>" : "<span class=\"tiny muted\">无数据</span>";
  }
  var order = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_overage_included", "overage"];
  keys.sort(function (x, y) {
    var ix = order.indexOf(x), iy = order.indexOf(y);
    if (ix === -1) ix = 99;
    if (iy === -1) iy = 99;
    return ix - iy || (x < y ? -1 : 1);
  });
  var h = "";
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var w = u.windows[k] || {};
    var label = k.indexOf("dim:") === 0 ? k.slice(4) : k;
    var reset = w.resetsAt ? "<span class=\"muted tiny\"> · 重置 " + esc(fmtTime(w.resetsAt * 1000)) + "</span>" : "";
    h += "<div class=\"tiny\">" + esc(label) + reset + "</div>" + usageBar(w);
  }
  return h;
}

function renderAccounts(list) {
  var h = "<div class=\"card\"><h2>添加账号</h2>";
  h += "<div class=\"row\">";
  h += "<div class=\"field\"><label>类型</label><select id=\"accKind\"><option value=\"oauth\">订阅 OAuth（粘贴 refresh_token）</option><option value=\"apikey\">Console API Key（sk-ant-...）</option></select></div>";
  h += "<div class=\"field\" style=\"flex:1;min-width:280px\"><label>凭据</label><input id=\"accSecret\" placeholder=\"粘贴 refresh_token 或 sk-ant-...\" style=\"width:100%\"></div>";
  h += "<div class=\"field\"><label>备注名（可选）</label><input id=\"accLabel\" placeholder=\"留空自动命名\"></div>";
  h += "<button class=\"btn\" onclick=\"actAddAccount()\">添加</button>";
  h += "<a class=\"btn ghost\" href=\"/login\" target=\"_blank\" rel=\"noopener\" style=\"text-decoration:none;padding:8px 16px;border-radius:7px\">OAuth 一键登录</a>";
  h += "</div>";
  h += "<div class=\"field\"><label>批量导入（每行一个，支持「备注名|凭据」格式，井号开头跳过）</label><textarea id=\"accBatch\" placeholder=\"主号|sk-ant-xxx&#10;备用号|sk-ant-yyy\"></textarea></div>";
  h += "<div class=\"row\" style=\"margin-top:10px\"><button class=\"btn ghost\" onclick=\"actBatchImport()\">批量导入</button><span class=\"muted tiny\">OAuth 批量导入需要各账号的 refresh_token。</span></div>";
  h += "</div>";

  h += "<div class=\"card\"><h2>号池（" + list.length + "）</h2>";
  if (!list.length) {
    h += "<p class=\"muted\">还没有账号。用上面的 OAuth 一键登录，或粘贴 refresh_token / Console Key。</p>";
  } else {
    h += "<table><thead><tr><th>备注</th><th>类型</th><th>状态</th><th>用量</th><th>凭据</th><th>到期</th><th>错误</th><th>最近错误</th><th>操作</th></tr></thead><tbody>";
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      var st = a.status === "active" ? "ok" : (a.status === "disabled" ? "dim" : "bad");
      var cooling = a.cooldownUntil && a.cooldownUntil * 1000 > Date.now();
      var exhausted = a.status === "exhausted";
      h += "<tr>";
      h += "<td>" + esc(a.label) + (a.email ? "<br><span class=\"muted tiny\">" + esc(a.email) + "</span>" : "") + "</td>";
      h += "<td>" + (a.kind === "apikey" ? "Console Key" : "OAuth") + "</td>";
      h += "<td><span class=\"pill " + st + "\">" + esc(a.status) + "</span>" + (cooling ? " <span class=\"pill warn\">冷却</span>" : "") + "</td>";
      h += "<td style=\"min-width:150px\">" + usageCell(a) +
        (exhausted ? "<div class=\"tiny\" style=\"color:var(--bad)\">" + esc(a.exhaustedReason || "额度耗尽") +
          (a.exhaustedUntil ? "<br>恢复 " + esc(fmtTime(a.exhaustedUntil * 1000)) : "") + "</div>" : "") + "</td>";
      h += "<td class=\"tiny\">" + (a.hasApiKey ? "key " + esc(a.apiKeyPreview || "") : "") + (a.hasRefreshToken ? "<br>refresh 有" : "") + "</td>";
      h += "<td class=\"tiny\">" + (a.expiresAt ? esc(fmtTime(a.expiresAt * 1000)) : "长期") + "</td>";
      h += "<td>" + a.errorCount + "</td>";
      h += "<td class=\"tiny muted\">" + esc(a.lastError || "-") + "</td>";
      h += "<td style=\"white-space:nowrap\">";
      if (a.status === "active") {
        h += "<button class=\"btn ghost sm\" onclick=\"actSetStatus('" + esc(a.id) + "','disabled')\">停用</button> ";
      } else {
        h += "<button class=\"btn ghost sm\" onclick=\"actSetStatus('" + esc(a.id) + "','active')\">启用</button> ";
      }
      if (exhausted) {
        h += "<button class=\"btn sm\" onclick=\"actRevive('" + esc(a.id) + "')\">恢复</button> ";
      }
      h += "<button class=\"btn ghost sm\" onclick=\"actFetchUsage('" + esc(a.id) + "')\">查用量</button> ";
      h += "<button class=\"btn ghost sm\" onclick=\"actReset('" + esc(a.id) + "')\">复位</button> ";
      h += "<button class=\"btn danger sm\" onclick=\"actDeleteAccount('" + esc(a.id) + "')\">删除</button>";
      h += "</td></tr>";
    }
    h += "</tbody></table>";
    h += "<div class=\"row\" style=\"margin-top:12px\">" +
      "<button class=\"btn ghost\" onclick=\"actReset('')\">全部解除冷却</button> " +
      "<button class=\"btn ghost\" onclick=\"actFetchUsageAll()\">查询全部用量</button> " +
      "<button class=\"btn ghost\" onclick=\"actRevive('')\">全部解除耗尽</button></div>";
  }
  h += "</div>";
  return h;
}

function renderKeys(list, accounts) {
  var h = "";
  if (CREATED_KEY) {
    h += "<div class=\"card\"><h2>新 Key 已创建（只显示这一次）</h2>";
    h += "<pre>" + esc(CREATED_KEY) + "</pre>";
    h += "<div class=\"row\" style=\"margin-top:10px\"><button class=\"btn\" onclick=\"copyText('" + esc(CREATED_KEY) + "')\">复制</button>" +
      "<button class=\"btn ghost\" onclick=\"CREATED_KEY=null;refresh()\">我已保存，隐藏</button></div></div>";
  }

  h += "<div class=\"card\"><h2>新建 API Key</h2><div class=\"row\">";
  h += "<div class=\"field\"><label>名称</label><input id=\"kName\" placeholder=\"例如 cursor / cherry\"></div>";
  h += "<div class=\"field\"><label>指纹策略</label><select id=\"kFp\">" +
    "<option value=\"claude_code\">claude_code（要求 Claude Code 头，走严格守卫）</option>" +
    "<option value=\"passthrough\">passthrough（放行第三方客户端，自动注入规范指纹）</option></select></div>";
  h += "<div class=\"field\"><label>绑定账号（可选）</label><select id=\"kBound\"><option value=\"\">自动调度</option>";
  for (var i = 0; i < accounts.length; i++) {
    h += "<option value=\"" + esc(accounts[i].id) + "\">" + esc(accounts[i].label) + "</option>";
  }
  h += "</select></div>";
  h += "</div>";
  h += "<div class=\"row\">";
  h += "<div class=\"field\"><label>允许协议（留空=全部）</label><input id=\"kProto\" placeholder=\"anthropic,openai\"></div>";
  h += "<div class=\"field\"><label>允许模型（留空=全部）</label><input id=\"kModels\" placeholder=\"claude-sonnet-4-5-20250929\"></div>";
  h += "<div class=\"field\"><label><input type=\"checkbox\" id=\"kQuota\"> 启用配额</label></div>";
  h += "<div class=\"field\"><label>每分钟请求上限</label><input id=\"kRpm\" type=\"number\" value=\"0\" style=\"width:120px\"></div>";
  h += "<div class=\"field\"><label>每日请求上限</label><input id=\"kDaily\" type=\"number\" value=\"0\" style=\"width:120px\"></div>";
  h += "<div class=\"field\"><label>每日 token 上限</label><input id=\"kTok\" type=\"number\" value=\"0\" style=\"width:140px\"></div>";
  h += "<button class=\"btn\" onclick=\"actCreateKey()\">创建</button>";
  h += "</div><div class=\"muted tiny\">配额是可控开关：不勾选「启用配额」时只统计不限流，上限填 0 表示该项不限制。</div>";
  h += "</div>";

  h += "<div class=\"card\"><h2>API Key（" + list.length + "）</h2>";
  if (!list.length) {
    h += "<p class=\"muted\">还没有 Key。</p>";
  } else {
    h += "<table><thead><tr><th>名称</th><th>Key</th><th>状态</th><th>指纹</th><th>限制</th><th>今日用量</th><th>操作</th></tr></thead><tbody>";
    for (var j = 0; j < list.length; j++) {
      var k = list[j];
      var limits = [];
      if (k.allowedProtocols.length) limits.push("协议: " + k.allowedProtocols.join("/"));
      if (k.allowedModels.length) limits.push("模型: " + k.allowedModels.length + " 个");
      if (k.boundAccountId) limits.push("绑定号");
      if (!limits.length) limits.push("无限制");
      var quota = k.quotaEnabled
        ? ("限速 " + (k.rateLimitPerMin || "不限") + "/分<br>日请求 " + (k.dailyRequestLimit || "不限") + "<br>日 token " + (k.dailyTokenLimit || "不限"))
        : "<span class=\"muted\">配额关闭</span>";
      h += "<tr>";
      h += "<td>" + esc(k.name) + "</td>";
      h += "<td class=\"mono tiny\">" + esc(k.keyPrefix) + "</td>";
      h += "<td><span class=\"pill " + (k.enabled ? "ok" : "dim") + "\">" + (k.enabled ? "启用" : "停用") + "</span></td>";
      h += "<td class=\"tiny\">" + esc(k.fingerprintMode) + "</td>";
      h += "<td class=\"tiny\">" + limits.join("<br>") + "<br>" + quota + "</td>";
      h += "<td class=\"tiny\">" + fmtNum(k.usageToday.requests) + " 次<br>" + fmtNum(k.usageToday.tokens) + " token</td>";
      h += "<td style=\"white-space:nowrap\">";
      h += "<button class=\"btn ghost sm\" onclick=\"actToggleKey('" + esc(k.id) + "'," + (k.enabled ? "false" : "true") + ")\">" + (k.enabled ? "停用" : "启用") + "</button> ";
      h += "<button class=\"btn ghost sm\" onclick=\"actToggleQuota('" + esc(k.id) + "'," + (k.quotaEnabled ? "false" : "true") + ")\">" + (k.quotaEnabled ? "关配额" : "开配额") + "</button> ";
      h += "<button class=\"btn ghost sm\" onclick=\"actToggleFp('" + esc(k.id) + "','" + (k.fingerprintMode === "claude_code" ? "passthrough" : "claude_code") + "')\">切指纹</button> ";
      h += "<button class=\"btn danger sm\" onclick=\"actDeleteKey('" + esc(k.id) + "')\">删除</button>";
      h += "</td></tr>";
    }
    h += "</tbody></table>";
  }
  h += "</div>";
  return h;
}

function pager(kind, total, pageIdx, size) {
  var pages = Math.max(1, Math.ceil(total / size));
  return "<div class=\"pager\"><button class=\"btn ghost sm\" onclick=\"pageMove('" + kind + "',-1)\">上一页</button>" +
    "<span class=\"muted tiny\">第 " + (pageIdx + 1) + " / " + pages + " 页</span>" +
    "<button class=\"btn ghost sm\" onclick=\"pageMove('" + kind + "',1)\">下一页</button></div>";
}

function renderReqLogs(page) {
  var h = "<div class=\"card\"><h2>请求日志</h2><div class=\"row\">";
  h += "<div class=\"field\"><label>结果</label><select id=\"fOutcome\"><option value=\"\">全部</option><option value=\"ok\">成功</option><option value=\"blocked\">被拦截</option><option value=\"error\">错误</option></select></div>";
  h += "<div class=\"field\"><label>协议</label><select id=\"fProto\"><option value=\"\">全部</option><option value=\"anthropic\">anthropic</option><option value=\"openai\">openai</option></select></div>";
  h += "<div class=\"field\" style=\"flex:1;min-width:220px\"><label>搜索（req-id / 路径 / 模型 / 账号 / IP）</label><input id=\"fSearch\" style=\"width:100%\"></div>";
  h += "<button class=\"btn\" onclick=\"applyReqFilters()\">查询</button>";
  h += "<button class=\"btn ghost\" onclick=\"clearReqFilters()\">重置</button>";
  h += "</div>";
  var rows = page.rows || [];
  h += "<div class=\"muted tiny\" style=\"margin-bottom:8px\">共 " + fmtNum(page.total || 0) + " 条，被拦截的行以红色底纹标出。</div>";
  if (!rows.length) {
    h += "<p class=\"muted\">没有记录。</p>";
  } else {
    h += "<table><thead><tr><th>时间</th><th>req-id</th><th>来源</th><th>Key</th><th>协议</th><th>模型</th><th>账号</th><th>状态</th><th>耗时</th><th>token（入/出/缓存）</th><th>说明</th></tr></thead><tbody>";
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var cls = r.outcome === "blocked" ? " class=\"blocked\"" : "";
      var pill = r.outcome === "ok" ? "ok" : (r.outcome === "blocked" ? "warn" : "bad");
      var note = r.outcome === "blocked" ? (r.blockReason || "blocked") + (r.blockDetail ? " · " + r.blockDetail : "") : (r.errorMessage || "");
      h += "<tr" + cls + ">";
      h += "<td class=\"tiny\">" + esc(fmtTime(r.ts)) + "<br><span class=\"muted\">" + esc(fmtAgo(r.ts)) + "</span></td>";
      h += "<td class=\"mono tiny\">" + esc(r.id) + "</td>";
      h += "<td class=\"tiny\">" + esc(r.clientIp || "-") + "</td>";
      h += "<td class=\"tiny\">" + esc(r.apiKeyName || "-") + "</td>";
      h += "<td class=\"tiny\">" + esc(r.protocol || "-") + (r.stream ? " <span class=\"pill dim\">SSE</span>" : "") + "</td>";
      h += "<td class=\"tiny\">" + esc(r.model || "-") + "</td>";
      h += "<td class=\"tiny\">" + esc(r.accountLabel || "-") + "</td>";
      h += "<td><span class=\"pill " + pill + "\">" + esc(String(r.status === null ? "-" : r.status)) + "</span></td>";
      h += "<td class=\"tiny\">" + (r.durationMs === null ? "-" : r.durationMs + " ms") + "</td>";
      h += "<td class=\"tiny\">" + fmtNum(r.promptTokens) + " / " + fmtNum(r.completionTokens) + " / " +
        fmtNum((r.cacheCreationTokens || 0) + (r.cacheReadTokens || 0)) + "</td>";
      h += "<td class=\"tiny muted\" style=\"max-width:320px;word-break:break-all\">" + esc(note) + "</td>";
      h += "</tr>";
    }
    h += "</tbody></table>";
  }
  h += pager("req", page.total || 0, DATA.reqPage, 50);
  h += "</div>";
  return h;
}

function renderRtLogs(page) {
  var h = "<div class=\"card\"><h2>运行日志</h2><div class=\"row\">";
  h += "<div class=\"field\"><label>级别</label><select id=\"fLevel\"><option value=\"\">全部</option><option value=\"debug\">debug</option><option value=\"info\">info</option><option value=\"warn\">warn</option><option value=\"error\">error</option></select></div>";
  h += "<div class=\"field\"><label>范围</label><input id=\"fScope\" placeholder=\"pool / auth / upstream\"></div>";
  h += "<div class=\"field\" style=\"flex:1;min-width:220px\"><label>搜索</label><input id=\"fRtSearch\" style=\"width:100%\"></div>";
  h += "<button class=\"btn\" onclick=\"applyRtFilters()\">查询</button>";
  h += "<button class=\"btn ghost\" onclick=\"clearRtFilters()\">重置</button>";
  h += "</div>";
  var rows = page.rows || [];
  h += "<div class=\"muted tiny\" style=\"margin-bottom:8px\">共 " + fmtNum(page.total || 0) + " 条。</div>";
  if (!rows.length) {
    h += "<p class=\"muted\">没有记录。</p>";
  } else {
    h += "<table><thead><tr><th>时间</th><th>级别</th><th>范围</th><th>消息</th></tr></thead><tbody>";
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var pill = r.level === "error" ? "bad" : (r.level === "warn" ? "warn" : "dim");
      h += "<tr>";
      h += "<td class=\"tiny\">" + esc(fmtTime(r.ts)) + "</td>";
      h += "<td><span class=\"pill " + pill + "\">" + esc(r.level) + "</span></td>";
      h += "<td class=\"tiny\">" + esc(r.scope || "-") + "</td>";
      h += "<td class=\"tiny\">" + esc(r.message) + (r.detail ? "<br><span class=\"muted mono\">" + esc(r.detail) + "</span>" : "") + "</td>";
      h += "</tr>";
    }
    h += "</tbody></table>";
  }
  h += pager("rt", page.total || 0, DATA.rtPage, 100);
  h += "</div>";
  return h;
}

function opt(v, cur) {
  return "<option value=\"" + v + "\"" + (v === cur ? " selected" : "") + ">" + v + "</option>";
}

function renderSettings(s) {
  var h = "<div class=\"card\"><h2>策略设置</h2>";
  h += "<div class=\"row\">";
  h += "<div class=\"field\"><label>请求头守卫</label><select id=\"sGuard\">" +
    opt("strict", s.guardMode) + opt("lenient", s.guardMode) + opt("off", s.guardMode) + "</select></div>";
  h += "<div class=\"field\"><label>隐写拦截</label><select id=\"sStego\">" +
    opt("block", s.stegoMode) + opt("strip", s.stegoMode) + opt("log", s.stegoMode) + opt("off", s.stegoMode) + "</select></div>";
  h += "<div class=\"field\"><label>请求 ID 回传</label><select id=\"sReqId\">" +
    opt("error", s.reqIdInResponse) + opt("always", s.reqIdInResponse) + opt("off", s.reqIdInResponse) + "</select></div>";
  h += "<div class=\"field\"><label><input type=\"checkbox\" id=\"sInject\"" + (s.injectMissing ? " checked" : "") + "> 注入缺失的 Claude Code 头</label></div>";
  h += "</div>";
  h += "<div class=\"muted tiny\" style=\"margin-bottom:12px\">这两项改动写入数据库后即刻生效；.env 里的同名项只在启动时读取。</div>";
  h += "<div class=\"row\">";
  h += "<div class=\"field\"><label>日志保留天数</label><input id=\"sDays\" type=\"number\" value=\"" + esc(s.logRetentionDays) + "\" style=\"width:120px\"></div>";
  h += "<div class=\"field\"><label>运行日志上限条数</label><input id=\"sMax\" type=\"number\" value=\"" + esc(s.runtimeLogMax) + "\" style=\"width:160px\"></div>";
  h += "<button class=\"btn\" onclick=\"actSaveSettings()\">保存</button>";
  h += "<button class=\"btn ghost\" onclick=\"actPrune()\">立即清理日志</button>";
  h += "</div></div>";

  h += "<div class=\"card\"><h2>接入信息</h2>";
  h += "<p class=\"muted tiny\">客户端 base_url 填网关地址；Anthropic 协议用 x-api-key 或 Authorization: Bearer，OpenAI 协议用 Authorization: Bearer。</p>";
  h += "<table><tbody>";
  h += "<tr><th>Anthropic 协议</th><td class=\"mono\">POST /v1/messages</td></tr>";
  h += "<tr><th>OpenAI 协议</th><td class=\"mono\">POST /v1/chat/completions</td></tr>";
  h += "<tr><th>模型列表</th><td class=\"mono\">GET /v1/models</td></tr>";
  h += "<tr><th>健康检查</th><td class=\"mono\">GET /healthz</td></tr>";
  h += "</tbody></table></div>";
  return h;
}

function refresh() {
  var v = el("view");
  if (TAB === "overview") {
    return api("overview").then(function (r) {
      v.innerHTML = renderOverview(r.data);
      el("hdrState").textContent = "可用账号 " + r.data.pool.active + " / " + r.data.pool.total;
    }).catch(showErr);
  }
  if (TAB === "accounts") {
    return api("accounts").then(function (r) {
      DATA.accounts = r.data;
      v.innerHTML = renderAccounts(r.data);
      el("hdrState").textContent = "号池 " + r.data.length + " 个";
    }).catch(showErr);
  }
  if (TAB === "keys") {
    return Promise.all([api("keys"), api("accounts")]).then(function (rs) {
      DATA.keys = rs[0].data;
      DATA.accounts = rs[1].data;
      v.innerHTML = renderKeys(DATA.keys, DATA.accounts);
      el("hdrState").textContent = "Key " + DATA.keys.length + " 个";
    }).catch(showErr);
  }
  if (TAB === "reqlogs") return loadReqLogs();
  if (TAB === "rtlogs") return loadRtLogs();
  if (TAB === "settings") {
    return api("settings").then(function (r) {
      DATA.settings = r.data;
      v.innerHTML = renderSettings(r.data);
      el("hdrState").textContent = "";
    }).catch(showErr);
  }
}

function showErr(e) {
  banner("err", "操作失败", e && e.message ? e.message : String(e));
}

function loadReqLogs() {
  var params = {
    limit: 50,
    offset: DATA.reqPage * 50,
    outcome: val("fOutcome") || undefined,
    protocol: val("fProto") || undefined,
    search: val("fSearch") || undefined
  };
  var keep = { outcome: params.outcome || "", protocol: params.protocol || "", search: params.search || "" };
  return api("logs.requests", { params: params }).then(function (r) {
    DATA.reqTotal = r.total;
    el("view").innerHTML = renderReqLogs(r);
    if (el("fOutcome")) el("fOutcome").value = keep.outcome;
    if (el("fProto")) el("fProto").value = keep.protocol;
    if (el("fSearch")) el("fSearch").value = keep.search;
    el("hdrState").textContent = "请求日志 " + r.total + " 条";
  }).catch(showErr);
}

function loadRtLogs() {
  var params = {
    limit: 100,
    offset: DATA.rtPage * 100,
    level: val("fLevel") || undefined,
    scope: val("fScope") || undefined,
    search: val("fRtSearch") || undefined
  };
  var keep = { level: params.level || "", scope: params.scope || "", search: params.search || "" };
  return api("logs.runtime", { params: params }).then(function (r) {
    DATA.rtTotal = r.total;
    el("view").innerHTML = renderRtLogs(r);
    if (el("fLevel")) el("fLevel").value = keep.level;
    if (el("fScope")) el("fScope").value = keep.scope;
    if (el("fRtSearch")) el("fRtSearch").value = keep.search;
    el("hdrState").textContent = "运行日志 " + r.total + " 条";
  }).catch(showErr);
}

function applyReqFilters() { DATA.reqPage = 0; loadReqLogs(); }
function clearReqFilters() { DATA.reqPage = 0; el("view").innerHTML = ""; loadReqLogs(); }
function applyRtFilters() { DATA.rtPage = 0; loadRtLogs(); }
function clearRtFilters() { DATA.rtPage = 0; el("view").innerHTML = ""; loadRtLogs(); }
function pageMove(kind, d) {
  if (kind === "req") { DATA.reqPage = Math.max(0, DATA.reqPage + d); loadReqLogs(); }
  else { DATA.rtPage = Math.max(0, DATA.rtPage + d); loadRtLogs(); }
}

function actAddAccount() {
  var secret = val("accSecret").trim();
  if (!secret) { banner("err", "凭据不能为空"); return; }
  api("account.create", { method: "POST", body: { kind: val("accKind"), secret: secret, label: val("accLabel") } })
    .then(function () { banner("info", "账号已添加"); refresh(); })
    .catch(showErr);
}
function actBatchImport() {
  var lines = val("accBatch");
  if (!lines.trim()) { banner("err", "批量内容为空"); return; }
  api("account.batch", { method: "POST", body: { kind: val("accKind"), lines: lines } })
    .then(function (r) {
      banner("info", "批量导入完成", "成功 " + r.data.created + " 个，失败 " + r.data.failed + " 个" + (r.data.errors.length ? "；" + r.data.errors[0] : ""));
      refresh();
    }).catch(showErr);
}
function actSetStatus(id, status) {
  api("account.update", { method: "POST", body: { id: id, status: status } })
    .then(function () { banner("info", "状态已更新"); refresh(); }).catch(showErr);
}
function actRevive(id) {
  api("account.revive", { method: "POST", body: { id: id, all: id === "" } })
    .then(function (r) { banner("info", "已解除额度封印", "恢复 " + ((r.data && r.data.revived) || 1) + " 个"); refresh(); })
    .catch(showErr);
}
function actFetchUsage(id) {
  banner("info", "正在查询上游用量…");
  api("account.usage", { method: "POST", body: { id: id, all: id === "" } })
    .then(function (r) {
      var list = r.data || [];
      var bad = 0;
      for (var i = 0; i < list.length; i++) if (!list[i].ok) bad += 1;
      banner("info", "用量已更新", bad ? (bad + " 个账号查询失败（Console Key 没有用量接口）") : "");
      refresh();
    }).catch(showErr);
}
function actFetchUsageAll() { actFetchUsage(""); }

function actReset(id) {
  api("account.reset", { method: "POST", body: { id: id, all: id === "" } })
    .then(function () { banner("info", "已解除冷却"); refresh(); }).catch(showErr);
}
function actDeleteAccount(id) {
  if (!confirm("确定删除该账号？")) return;
  api("account.delete", { method: "POST", body: { id: id } })
    .then(function () { banner("info", "账号已删除"); refresh(); }).catch(showErr);
}
function actCreateKey() {
  api("key.create", {
    method: "POST",
    body: {
      name: val("kName"),
      fingerprintMode: val("kFp"),
      boundAccountId: val("kBound"),
      allowedProtocols: val("kProto"),
      allowedModels: val("kModels"),
      quotaEnabled: checked("kQuota"),
      rateLimitPerMin: num("kRpm"),
      dailyRequestLimit: num("kDaily"),
      dailyTokenLimit: num("kTok")
    }
  }).then(function (r) {
    CREATED_KEY = r.data.plaintext;
    refresh();
  }).catch(showErr);
}
function actToggleKey(id, enabled) {
  api("key.update", { method: "POST", body: { id: id, enabled: enabled } }).then(refresh).catch(showErr);
}
function actToggleQuota(id, on) {
  api("key.update", { method: "POST", body: { id: id, quotaEnabled: on } }).then(refresh).catch(showErr);
}
function actToggleFp(id, mode) {
  api("key.update", { method: "POST", body: { id: id, fingerprintMode: mode } }).then(refresh).catch(showErr);
}
function actDeleteKey(id) {
  if (!confirm("确定删除该 Key？删除后使用它的客户端会立刻失效。")) return;
  api("key.delete", { method: "POST", body: { id: id } }).then(function () { banner("info", "Key 已删除"); refresh(); }).catch(showErr);
}
function actSaveSettings() {
  api("settings.save", {
    method: "POST",
    body: {
      guardMode: val("sGuard"),
      stegoMode: val("sStego"),
      reqIdInResponse: val("sReqId"),
      injectMissing: checked("sInject"),
      logRetentionDays: num("sDays"),
      runtimeLogMax: num("sMax")
    }
  }).then(function () { banner("info", "设置已保存"); refresh(); }).catch(showErr);
}
function actPrune() {
  api("logs.prune", { method: "POST", body: { days: num("sDays"), maxRows: num("sMax") } })
    .then(function () { banner("info", "日志已清理"); refresh(); }).catch(showErr);
}

renderNav();
if (!HAS_ADMIN) {
  el("adminWarn").innerHTML = "<div class=\"warnbox\">未设置 ADMIN_TOKEN，面板与 /panel/api 处于无鉴权状态。强烈建议在 .env 里设置一个强随机值后重启。</div>";
}
refresh();
setInterval(function () { if (TAB === "overview") refresh(); }, 15000);
</script>
</body>
</html>`;
