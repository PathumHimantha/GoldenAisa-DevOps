// ─────────────────────────────────────────────────────────────
// CONFIG  — edit these two values only
// ─────────────────────────────────────────────────────────────
const API_BASE = "https://application.goldenasia.lk/api/monitor-api";
const API_TOKEN =
  sessionStorage.getItem("monitor_token") ||
  "c1c02da65df7926806b18d9709e0f86fff3ffba55ea5808e9690f02868096c34";

// Login credentials (frontend-only gate; real security is the API token)
const CREDS = { admin: "Golden@Monitor2026" };

// ─────────────────────────────────────────────────────────────
// API HELPER
// ─────────────────────────────────────────────────────────────
const apiFetch = async (endpoint) => {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    headers: { "x-monitor-token": API_TOKEN },
  });
  if (!res.ok) throw new Error(`${endpoint} → HTTP ${res.status}`);
  return res.json();
};

// ─────────────────────────────────────────────────────────────
// LIVE DATA  — fetched once per refresh cycle, stored here
// ─────────────────────────────────────────────────────────────
let LIVE = null;

const fetchAll = async () => {
  const [server, services, ssl, mysql, cron, security, logs] =
    await Promise.all([
      apiFetch("/server"),
      apiFetch("/services"),
      apiFetch("/ssl"),
      apiFetch("/mysql"),
      apiFetch("/cron"),
      apiFetch("/security"),
      apiFetch("/logs/all"),
    ]);

  // ── normalise server ──────────────────────────────────────
  const serverNorm = {
    uptime: server.uptime || "—",
    uptime_since: server.uptime_since || "—",
    cpu: server.cpu || 0,
    load: server.load || [0, 0, 0],
    ram_used: server.ram_used || 0,
    ram_total: server.ram_total || 0,
    disk_used: server.disk_used || 0,
    disk_total: server.disk_total || 0,
    response_ms: server.response_ms || 0,
    ping_ms: server.ping_ms || 0,
    packet_loss: server.packet_loss || "0%",
    rx: server.rx || "—",
    tx: server.tx || "—",
  };

  // ── normalise services list ───────────────────────────────
  const ICONS = {
    nginx: "ti-topology-star",
    mysql: "ti-database",
    "php8.4-fpm": "ti-code",
    ufw: "ti-shield-check",
  };
  const servicesList = (services.services || []).map((s) => ({
    name: s.display,
    icon: ICONS[s.key] || "ti-circle-dot",
    status: s.status,
    meta: s.meta || "",
  }));

  // ── normalise pm2 ─────────────────────────────────────────
  const pm2List = (services.pm2 || []).map((p) => ({
    name: p.name,
    status: p.status,
    cpu: p.cpu,
    mem: p.mem,
    restarts: p.restarts,
  }));

  // ── normalise node health (from /services node_process) ──
  const np = services.node_process || {};
  const nodeNorm = {
    status: np.pid ? "ok" : "unknown",
    db: mysql.status === "running" ? "connected" : "error",
    uptime: np.uptime_sec ? fmtUptime(np.uptime_sec) : "—",
    version: "Node.js " + (process?.version || "—"),
    response_ms: server.response_ms || 0,
    memory_mb: np.heap_used || np.rss_mb || 0,
  };

  // ── normalise mysql ───────────────────────────────────────
  const totalMB = (mysql.databases || []).reduce(
    (a, d) => a + parseFloat(d.size_mb || 0),
    0,
  );
  const mysqlNorm = {
    status: mysql.status || "unknown",
    connections: mysql.connections || 0,
    slow_queries: mysql.slow_queries || 0,
    db_size_mb: Math.round(totalMB),
    last_backup: mysql.last_backup || "Never",
    backup_exists: mysql.backup_exists || false,
  };

  // ── normalise network (from server endpoint) ──────────────
  const networkNorm = {
    ping_ms: server.ping_ms || 0,
    packet_loss: server.packet_loss || "0%",
    rx: server.rx || "—",
    tx: server.tx || "—",
  };

  // ── normalise SSL ─────────────────────────────────────────
  const sslList = (ssl.domains || []).map((d) => ({
    domain: d.domain,
    days: d.days ?? 0,
    valid: d.valid || false,
    http_code: d.http_code || 0,
    http_redirect: d.http_redirect || false,
  }));

  // ── normalise domains (reuse ssl data) ───────────────────
  const domainList = (ssl.domains || []).map((d) => ({
    url: d.domain,
    status: d.http_code || 200,
    ok: d.http_redirect === true,
  }));

  // ── normalise cron ────────────────────────────────────────
  const cronList = (cron.jobs || []).map((j) => ({
    name: j.name,
    last: j.last_run ? new Date(j.last_run).toLocaleString("en-GB") : "Never",
    status: j.status || "unknown",
    duration: j.duration || "—",
  }));

  // ── normalise security ────────────────────────────────────
  const sec = security;
  const secNorm = {
    ufw: sec.ufw?.status || "inactive",
    ssh_fails: sec.ssh?.failed_logins_24h || 0,
    sessions: sec.sessions?.count || 0,
    backup_date: mysql.last_backup ? mysql.last_backup.split(" ")[0] : "—",
    backup_file: mysql.backup_exists || false,
  };

  // ── normalise logs ────────────────────────────────────────
  const logsNorm = {
    nginx: logs.nginx || [],
    node: logs.node || [],
    mysql: logs.mysql || [],
    php: logs.php || [],
  };

  return {
    server: serverNorm,
    services: servicesList,
    pm2: pm2List,
    node: nodeNorm,
    mysql: mysqlNorm,
    network: networkNorm,
    ssl: sslList,
    domains: domainList,
    cron: cronList,
    security: secNorm,
    logs: logsNorm,
  };
};

// helper: seconds → "Xd Yh Zm"
function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

// ─────────────────────────────────────────────────────────────
// TIMER & REFRESH
// ─────────────────────────────────────────────────────────────
let timerInterval = null;
const REFRESH_SEC = 60;

function startTimer() {
  const bar = document.getElementById("timer-bar");
  if (!bar) return;
  bar.style.transition = "none";
  bar.style.width = "100%";
  setTimeout(() => {
    bar.style.transition = `width ${REFRESH_SEC}s linear`;
    bar.style.width = "0%";
  }, 100);
  timerInterval = setTimeout(() => {
    renderAll();
    startTimer();
  }, REFRESH_SEC * 1000);
}

async function refresh() {
  clearTimeout(timerInterval);
  await renderAll();
  startTimer();
}

// ─────────────────────────────────────────────────────────────
// LOGIN / LOGOUT
// ─────────────────────────────────────────────────────────────
function doLogin() {
  const u = document.getElementById("u").value.trim();
  const p = document.getElementById("p").value;
  if (CREDS[u] === p) {
    const tokenInput = document.getElementById("token-input");
    if (tokenInput?.value)
      sessionStorage.setItem("monitor_token", tokenInput.value);

    document.getElementById("login-screen").style.display = "none";
    document.getElementById("app").style.display = "block";
    renderAll();
    startTimer();
  } else {
    document.getElementById("lerr").textContent = "Invalid credentials";
  }
}

document.addEventListener("keydown", (e) => {
  if (
    e.key === "Enter" &&
    document.getElementById("login-screen").style.display !== "none"
  )
    doLogin();
});

function doLogout() {
  clearTimeout(timerInterval);
  document.getElementById("app").style.display = "none";
  document.getElementById("login-screen").style.display = "flex";
  document.getElementById("u").value = "";
  document.getElementById("p").value = "";
  document.getElementById("lerr").textContent = "";
  LIVE = null;
}

// ─────────────────────────────────────────────────────────────
// RENDER ALL  — fetches live data then calls every renderer
// ─────────────────────────────────────────────────────────────
async function renderAll() {
  showLoadingState(true);
  try {
    LIVE = await fetchAll();
    showLoadingState(false);
  } catch (err) {
    console.error("API Error:", err);
    showError("API unreachable — " + err.message);
    showLoadingState(false);
    return;
  }

  const updatedEl = document.getElementById("last-updated");
  if (updatedEl)
    updatedEl.textContent = "Updated " + new Date().toLocaleTimeString();

  renderAlerts();
  renderServer();
  renderServices();
  renderPM2();
  renderNode();
  renderMySQL();
  renderNetwork();
  renderSSL();
  renderDomains();
  renderCron();
  renderSecurity();
  renderLogs();
  renderHealthBadge();
}

function showLoadingState(on) {
  const el = document.getElementById("alerts-section");
  if (!el) return;
  if (on)
    el.innerHTML = `<div class="alert-banner alert-ok" style="opacity:0.5"><i class="ti ti-loader" aria-hidden="true"></i> Fetching live data...</div>`;
}

function showError(msg) {
  const el = document.getElementById("alerts-section");
  if (el) {
    el.innerHTML = `<div class="alert-banner alert-err"><i class="ti ti-alert-triangle" aria-hidden="true"></i> ${msg}</div>`;
  }
}

// ─────────────────────────────────────────────────────────────
// ALL RENDER FUNCTIONS
// ─────────────────────────────────────────────────────────────
function pct(a, b) {
  if (!b || b === 0) return 0;
  return Math.round((a / b) * 100);
}
function barClass(p) {
  return p > 85 ? "fill-red" : p > 65 ? "fill-amber" : "fill-green";
}
function pillClass(s) {
  return s === "running" || s === "online" || s === "success"
    ? "pill-green"
    : s === "stopped" || s === "failed"
      ? "pill-red"
      : "pill-amber";
}

function renderAlerts() {
  const d = LIVE;
  const alerts = [];

  if (d.server.cpu > 80)
    alerts.push({
      cls: "alert-err",
      msg: `CPU at ${d.server.cpu}% — exceeds 80% threshold`,
    });

  const ramPct = pct(d.server.ram_used, d.server.ram_total);
  if (ramPct > 85)
    alerts.push({
      cls: "alert-err",
      msg: `RAM at ${ramPct}% — exceeds 85% threshold`,
    });

  const diskPct = pct(d.server.disk_used, d.server.disk_total);
  const diskFree = Math.round(100 - diskPct);
  if (diskFree < 15 && diskFree > 0)
    alerts.push({ cls: "alert-warn", msg: `Disk only ${diskFree}% free` });

  d.ssl.forEach((s) => {
    if (s.days > 0 && s.days < 15)
      alerts.push({
        cls: "alert-err",
        msg: `SSL expiring in ${s.days} days — ${s.domain}`,
      });
    else if (s.days > 0 && s.days < 30)
      alerts.push({
        cls: "alert-warn",
        msg: `SSL expires in ${s.days} days — ${s.domain}`,
      });
  });

  d.cron
    .filter((c) => c.status === "failed")
    .forEach((c) =>
      alerts.push({ cls: "alert-warn", msg: `Cron job failed: ${c.name}` }),
    );
  d.pm2
    .filter((p) => p.status === "stopped")
    .forEach((p) =>
      alerts.push({ cls: "alert-warn", msg: `PM2 process stopped: ${p.name}` }),
    );

  const el = document.getElementById("alerts-section");
  if (!el) return;

  if (alerts.length === 0) {
    el.innerHTML = `<div class="alert-banner alert-ok"><i class="ti ti-circle-check" aria-hidden="true"></i> No critical alerts — all systems operating normally</div>`;
    return;
  }
  el.innerHTML = alerts
    .map(
      (a) =>
        `<div class="alert-banner ${a.cls}"><i class="ti ti-alert-triangle" aria-hidden="true"></i> ${a.msg}</div>`,
    )
    .join("");
}

function renderServer() {
  const s = LIVE.server;

  const uptimeEl = document.getElementById("uptime");
  if (uptimeEl) uptimeEl.textContent = s.uptime;

  const uptimeSubEl = document.getElementById("uptime-sub");
  if (uptimeSubEl) uptimeSubEl.textContent = s.uptime_since;

  const cp = s.cpu;
  const cpuValEl = document.getElementById("cpu-val");
  if (cpuValEl) cpuValEl.textContent = cp + "%";

  const cb = document.getElementById("cpu-bar");
  if (cb) {
    cb.style.width = cp + "%";
    cb.className = "progress-fill " + barClass(cp);
  }

  const cpuLoadEl = document.getElementById("cpu-load");
  if (cpuLoadEl && s.load) {
    cpuLoadEl.textContent = `Load: ${s.load[0]} / ${s.load[1]} / ${s.load[2]}`;
  }

  const rp = pct(s.ram_used, s.ram_total);
  const ramValEl = document.getElementById("ram-val");
  if (ramValEl) ramValEl.textContent = rp + "%";

  const rb = document.getElementById("ram-bar");
  if (rb) {
    rb.style.width = rp + "%";
    rb.className = "progress-fill " + barClass(rp);
  }

  const ramSubEl = document.getElementById("ram-sub");
  if (ramSubEl) {
    ramSubEl.textContent = `${s.ram_used} GB / ${s.ram_total} GB`;
  }

  const dp = pct(s.disk_used, s.disk_total);
  const diskValEl = document.getElementById("disk-val");
  if (diskValEl) diskValEl.textContent = dp + "%";

  const db2 = document.getElementById("disk-bar");
  if (db2) {
    db2.style.width = dp + "%";
    db2.className = "progress-fill " + barClass(dp);
  }

  const diskSubEl = document.getElementById("disk-sub");
  if (diskSubEl) {
    diskSubEl.textContent = `${s.disk_used} GB / ${s.disk_total} GB used`;
  }
}

function renderServices() {
  const el = document.getElementById("services-list");
  if (!el) return;
  el.innerHTML = LIVE.services
    .map(
      (s) =>
        `<div class="service-row">
      <span class="service-name"><i class="ti ${s.icon}" aria-hidden="true"></i>${s.name}<span class="service-meta">${s.meta}</span></span>
      <span class="status-pill ${pillClass(s.status)}">${s.status}</span>
    </div>`,
    )
    .join("");
}

function renderPM2() {
  const el = document.getElementById("pm2-list");
  if (!el) return;
  el.innerHTML = LIVE.pm2
    .map(
      (p) =>
        `<div class="service-row">
      <span class="service-name"><i class="ti ti-circle-dot" aria-hidden="true"></i>${p.name}<span class="service-meta">↺${p.restarts}</span></span>
      <span style="font-size:11px;color:var(--text3);margin-right:8px;">${p.cpu} / ${p.mem}</span>
      <span class="status-pill ${pillClass(p.status)}">${p.status}</span>
    </div>`,
    )
    .join("");
}

function renderNode() {
  const n = LIVE.node;
  const el = document.getElementById("node-health");
  if (!el) return;
  el.innerHTML = `
    <div class="service-row"><span class="service-name">Status</span><span class="status-pill ${n.status === "ok" ? "pill-green" : "pill-red"}">${n.status}</span></div>
    <div class="service-row"><span class="service-name">Database</span><span class="status-pill ${n.db === "connected" ? "pill-green" : "pill-red"}">${n.db}</span></div>
    <div class="service-row"><span class="service-name">Response time</span><span style="font-size:13px;color:${n.response_ms < 50 ? "var(--green)" : n.response_ms < 200 ? "var(--amber)" : "var(--red)"};">${n.response_ms} ms</span></div>
    <div class="service-row"><span class="service-name">Memory</span><span style="font-size:13px;color:var(--text2);">${n.memory_mb} MB</span></div>
    <div class="service-row"><span class="service-name">Version</span><span style="font-size:12px;color:var(--blue);">${n.version}</span></div>
    <div class="service-row" style="border-bottom:none;"><span class="service-name">Uptime</span><span style="font-size:12px;color:var(--text2);">${n.uptime}</span></div>`;
}

function renderMySQL() {
  const m = LIVE.mysql;
  const sizeStr =
    m.db_size_mb > 1024
      ? (m.db_size_mb / 1024).toFixed(2) + " GB"
      : m.db_size_mb + " MB";
  const el = document.getElementById("mysql-health");
  if (!el) return;
  el.innerHTML = `
    <div class="service-row"><span class="service-name">Status</span><span class="status-pill pill-green">${m.status}</span></div>
    <div class="service-row"><span class="service-name">Connections</span><span style="font-size:13px;color:var(--text2);">${m.connections} active</span></div>
    <div class="service-row"><span class="service-name">Slow queries</span><span style="font-size:13px;color:${m.slow_queries > 0 ? "var(--amber)" : "var(--green)"};">${m.slow_queries}</span></div>
    <div class="service-row"><span class="service-name">DB size</span><span style="font-size:13px;color:var(--text2);">${sizeStr}</span></div>
    <div class="service-row" style="border-bottom:none;"><span class="service-name">Last backup</span><span style="font-size:12px;color:${m.last_backup === "Never" ? "var(--red)" : "var(--green)"};">${m.last_backup}</span></div>`;
}

function renderNetwork() {
  const n = LIVE.network;
  const el = document.getElementById("network-health");
  if (!el) return;
  el.innerHTML = `
    <div class="service-row"><span class="service-name">Ping latency</span><span style="font-size:13px;color:${n.ping_ms < 20 ? "var(--green)" : "var(--amber)"};">${n.ping_ms} ms</span></div>
    <div class="service-row"><span class="service-name">Packet loss</span><span style="font-size:13px;color:${n.packet_loss === "0%" ? "var(--green)" : "var(--red)"};">${n.packet_loss}</span></div>
    <div class="service-row"><span class="service-name">Data in</span><span style="font-size:13px;color:var(--text2);">${n.rx}</span></div>
    <div class="service-row" style="border-bottom:none;"><span class="service-name">Data out</span><span style="font-size:13px;color:var(--text2);">${n.tx}</span></div>`;
}

function renderSSL() {
  const el = document.getElementById("ssl-list");
  if (!el) return;
  el.innerHTML = LIVE.ssl
    .map((s) => {
      const pillCls =
        s.days > 0 && s.days < 15
          ? "pill-red"
          : s.days > 0 && s.days < 30
            ? "pill-amber"
            : "pill-green";
      return `<div class="ssl-item">
      <div><div class="ssl-domain">${s.domain}</div><div style="font-size:11px;color:var(--text3);margin-top:2px;">${s.valid ? "✓ Valid certificate" : "✗ Invalid / Error"}</div></div>
      <span class="status-pill ${pillCls}" style="white-space:nowrap;">${s.days > 0 ? s.days + " days left" : "Expired/Error"}</span>
    </div>`;
    })
    .join("");
}

function renderDomains() {
  const el = document.getElementById("domain-list");
  if (!el) return;
  el.innerHTML = LIVE.domains
    .map(
      (d) =>
        `<div class="ssl-item">
      <div><div class="ssl-domain">${d.url}</div><div style="font-size:11px;color:var(--text3);margin-top:2px;">HTTP → HTTPS redirect</div></div>
      <span class="status-pill ${d.ok ? "pill-green" : "pill-red"}">${d.ok ? d.status + " OK" : d.status + " Error"}</span>
    </div>`,
    )
    .join("");
}

function renderCron() {
  const el = document.getElementById("cron-list");
  if (!el) return;
  el.innerHTML = LIVE.cron
    .map(
      (c) =>
        `<div class="cron-row">
      <span class="cron-name">${c.name}</span>
      <span class="cron-time">${c.last}</span>
      <span class="cron-dur">${c.duration}</span>
      <span class="status-pill ${pillClass(c.status)}">${c.status}</span>
    </div>`,
    )
    .join("");
}

function renderSecurity() {
  const s = LIVE.security;

  const ufwEl = document.getElementById("ufw-val");
  if (ufwEl) {
    ufwEl.textContent = s.ufw;
    ufwEl.style.color = s.ufw === "active" ? "var(--green)" : "var(--red)";
  }

  const sshEl = document.getElementById("ssh-fail");
  if (sshEl) {
    sshEl.textContent = s.ssh_fails;
    sshEl.style.color =
      s.ssh_fails > 10
        ? "var(--red)"
        : s.ssh_fails > 0
          ? "var(--amber)"
          : "var(--green)";
  }

  const sessionsEl = document.getElementById("sessions-val");
  if (sessionsEl) sessionsEl.textContent = s.sessions;

  const backupValEl = document.getElementById("backup-val");
  if (backupValEl) backupValEl.textContent = s.backup_date;

  const backupSubEl = document.getElementById("backup-sub");
  if (backupSubEl) {
    backupSubEl.textContent = s.backup_file
      ? "✓ Backup file verified"
      : "✗ Backup missing";
    backupSubEl.style.color = s.backup_file ? "var(--green)" : "var(--red)";
  }
}

const LOG_KEYS = ["nginx", "mysql", "node", "php"];
let activeLog = "nginx";

function renderLogs() {
  const tabs = document.getElementById("log-tabs");
  if (tabs && !tabs.children.length) {
    tabs.innerHTML = LOG_KEYS.map(
      (k) =>
        `<button class="log-tab ${k === activeLog ? "active" : ""}" onclick="switchLog('${k}')">${k.toUpperCase()}</button>`,
    ).join("");
  }
  showLog(activeLog);
}

function switchLog(k) {
  activeLog = k;
  const tabs = document.querySelectorAll(".log-tab");
  tabs.forEach((t) =>
    t.classList.toggle("active", t.textContent.toLowerCase() === k),
  );
  showLog(k);
}

function showLog(k) {
  const lines = LIVE?.logs?.[k] || [];
  const el = document.getElementById("log-output");
  if (!el) return;
  el.innerHTML = lines
    .slice(0, 50)
    .map(
      (l) =>
        `<div class="log-line"><span class="log-ts">${l.ts || "—"}</span><span class="log-${l.level || "info"}">${l.msg || JSON.stringify(l)}</span></div>`,
    )
    .join("");
  if (lines.length === 0) {
    el.innerHTML =
      '<div class="log-line"><span class="log-info">No logs available</span></div>';
  }
}

function renderHealthBadge() {
  const hasErr =
    LIVE.cron.some((c) => c.status === "failed") ||
    LIVE.pm2.some((p) => p.status === "stopped") ||
    LIVE.ssl.some((s) => s.days > 0 && s.days < 15);
  const hasWarn =
    LIVE.ssl.some((s) => s.days > 0 && s.days < 30) || LIVE.server.cpu > 60;

  const badge = document.getElementById("health-badge");
  const pulse = document.getElementById("health-pulse");
  const label = document.getElementById("health-label");

  if (!badge) return;

  if (hasErr) {
    badge.className = "health-score red";
    if (pulse) pulse.className = "pulse pulse-red";
    if (label) label.textContent = "Issues Detected";
  } else if (hasWarn) {
    badge.className = "health-score amber";
    if (pulse) pulse.className = "pulse pulse-amber";
    if (label) label.textContent = "Warning";
  } else {
    badge.className = "health-score green";
    if (pulse) pulse.className = "pulse pulse-green";
    if (label) label.textContent = "All Systems Healthy";
  }
}
