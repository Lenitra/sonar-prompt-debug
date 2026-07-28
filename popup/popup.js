"use strict";

// Firefox et Safari exposent l'API WebExtension via `browser` (promesses) ;
// les navigateurs Chromium ne fournissent que `chrome`.
if (typeof globalThis.browser === "undefined") {
  globalThis.browser = globalThis.chrome;
}

const DEFAULT_TEMPLATE = `Tu es un développeur senior. Je te donne la liste condensée des issues SonarQube du projet "{{PROJECT}}" ({{COUNT}} issues listées sur {{TOTAL}} au total).

Consignes :
- Corrige ces issues dans le code, en respectant le style et les conventions existantes du projet.
- Traite-les par ordre de sévérité décroissante.
- Ne change pas le comportement fonctionnel ; si une correction est risquée ou ambiguë, signale-la au lieu de l'appliquer.
- À la fin, fais un résumé des corrections effectuées et de celles laissées de côté.

Issues SonarQube :

{{ISSUES}}`;

// Ancienne taxonomie (BLOCKER…INFO) et nouvelle "Clean Code" (HIGH/MEDIUM/LOW) confondues.
const SEV_RANK = { BLOCKER: 0, CRITICAL: 1, HIGH: 1, MAJOR: 2, MEDIUM: 2, MINOR: 3, LOW: 3, INFO: 4 };

const DEFAULT_OPTS = { grouping: "rule", maxIssues: 500, useFilters: true, template: DEFAULT_TEMPLATE };

const $ = (id) => document.getElementById(id);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

let lastProject = "";

/* ---------- Options (persistées) ---------- */

function readOptsFromUi() {
  return {
    grouping: $("grouping").value,
    maxIssues: clamp(parseInt($("maxIssues").value, 10) || 500, 1, 10000),
    useFilters: $("useFilters").checked,
    template: $("template").value || DEFAULT_TEMPLATE,
  };
}

async function saveOpts() {
  await browser.storage.local.set(readOptsFromUi());
}

/* ---------- Analyse de l'URL SonarQube ---------- */

// Retire la partie "page" de l'URL pour retrouver la racine de l'instance,
// y compris avec un context path (ex. https://host/sonar/project/issues → https://host/sonar).
const PAGE_MARKERS = [
  "/project/issues",
  "/project/",
  "/issues",
  "/dashboard",
  "/security_hotspots",
  "/component_measures",
  "/code",
  "/portfolio",
  "/summary",
];

function deriveSonarBase(tabUrl) {
  const url = new URL(tabUrl);
  let path = url.pathname;
  let cut = -1;
  for (const m of PAGE_MARKERS) {
    const idx = path.indexOf(m);
    if (idx === -1) continue;
    const after = path.charAt(idx + m.length);
    if (after !== "" && after !== "/" && !m.endsWith("/")) continue;
    if (cut === -1 || idx < cut) cut = idx;
  }
  if (cut !== -1) path = path.slice(0, cut);
  path = path.replace(/\/+$/, "");
  return url.origin + path;
}

// Les paramètres de la page Issues correspondent quasiment 1:1 à ceux de
// l'API /api/issues/search : on les recopie tels quels (sauf "id" → componentKeys).
function buildQuery(tabUrl, useFilters) {
  const src = new URL(tabUrl).searchParams;
  const out = new URLSearchParams();
  const skip = new Set(["open", "ps", "p", "id", "tab", "why"]);
  if (useFilters) {
    for (const [k, v] of src.entries()) {
      if (!skip.has(k)) out.append(k, v);
    }
  } else {
    for (const k of ["branch", "pullRequest"]) {
      const v = src.get(k);
      if (v) out.set(k, v);
    }
  }
  const id = src.get("id");
  if (id) out.set("componentKeys", id);
  const statusKeys = ["resolved", "statuses", "issueStatuses", "resolutions"];
  if (!statusKeys.some((k) => out.has(k))) out.set("resolved", "false");
  return { query: out.toString(), projectKey: id || "" };
}

/* ---------- Fonction injectée dans l'onglet SonarQube ----------
   Exécutée dans le contexte de la page : les requêtes vers /api sont
   same-origin et réutilisent la session SonarQube déjà ouverte.
   Doit rester autonome (aucune référence au scope de popup.js). */

async function collectIssues(apiBase, query, maxIssues) {
  const out = { ok: false, status: 0, error: null, total: 0, issues: [], components: {} };
  try {
    const ps = Math.min(500, maxIssues);
    let page = 1;
    for (;;) {
      const url = `${apiBase}/api/issues/search?${query ? query + "&" : ""}ps=${ps}&p=${page}`;
      const resp = await fetch(url, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      out.status = resp.status;
      if (!resp.ok) {
        out.error = `HTTP ${resp.status}`;
        return out;
      }
      const data = await resp.json();
      out.total =
        data.paging && typeof data.paging.total === "number" ? data.paging.total : data.total || 0;
      for (const c of data.components || []) {
        out.components[c.key] = c.path || c.longName || c.key;
      }
      for (const i of data.issues || []) {
        out.issues.push({
          rule: i.rule || "?",
          severity: i.severity || null,
          type: i.type || null,
          message: i.message || "",
          line: i.line || null,
          component: i.component || "",
          impacts: Array.isArray(i.impacts) ? i.impacts : [],
        });
      }
      const got = data.issues ? data.issues.length : 0;
      if (
        got < ps ||
        out.issues.length >= maxIssues ||
        out.issues.length >= out.total ||
        (page + 1) * ps > 10000 // l'API refuse au-delà de 10 000 résultats
      ) {
        break;
      }
      page++;
    }
    out.issues = out.issues.slice(0, maxIssues);
    out.ok = true;
    return out;
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
    return out;
  }
}

/* ---------- Condensation ---------- */

function sevOf(i) {
  if (i.severity && SEV_RANK[i.severity] !== undefined) return i.severity;
  if (i.impacts.length) {
    const best = [...i.impacts].sort(
      (a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9)
    )[0];
    if (best && best.severity) return best.severity;
  }
  return i.severity || "INFO";
}

const rank = (i) => SEV_RANK[sevOf(i)] ?? 9;

function pathOf(i, components) {
  if (components[i.component]) return components[i.component];
  const idx = i.component.indexOf(":");
  return idx > -1 ? i.component.slice(idx + 1) : i.component || "(projet)";
}

const locOf = (i, components) => pathOf(i, components) + (i.line ? ":" + i.line : "");

const byLoc = (components) => (a, b) =>
  pathOf(a, components).localeCompare(pathOf(b, components)) || (a.line || 0) - (b.line || 0);

function renderByRule(issues, components) {
  const groups = new Map();
  for (const it of issues) {
    if (!groups.has(it.rule)) groups.set(it.rule, []);
    groups.get(it.rule).push(it);
  }
  const sorted = [...groups.entries()].sort(
    (a, b) =>
      Math.min(...a[1].map(rank)) - Math.min(...b[1].map(rank)) ||
      b[1].length - a[1].length ||
      a[0].localeCompare(b[0])
  );
  const parts = [];
  for (const [rule, items] of sorted) {
    items.sort(byLoc(components));
    const worst = items.reduce((m, i) => (rank(i) < rank(m) ? i : m), items[0]);
    const tags = [`[${sevOf(worst)}]`];
    if (items[0].type) tags.push(`[${items[0].type}]`);
    parts.push(`### ${tags.join("")} ${rule} — ${items.length} occurrence${items.length > 1 ? "s" : ""}`);
    const messages = new Set(items.map((i) => i.message));
    if (messages.size === 1 && items[0].message) {
      parts.push(items[0].message);
      for (const i of items) parts.push(`- ${locOf(i, components)}`);
    } else {
      for (const i of items) parts.push(`- ${locOf(i, components)} — ${i.message}`);
    }
    parts.push("");
  }
  return parts.join("\n");
}

function renderByFile(issues, components) {
  const groups = new Map();
  for (const it of issues) {
    const p = pathOf(it, components);
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(it);
  }
  const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const parts = [];
  for (const [file, items] of sorted) {
    items.sort((a, b) => (a.line || 0) - (b.line || 0) || rank(a) - rank(b));
    parts.push(`### ${file} — ${items.length} issue${items.length > 1 ? "s" : ""}`);
    for (const i of items) {
      parts.push(`- ${i.line ? "L" + i.line + " " : ""}[${sevOf(i)}] ${i.message} (${i.rule})`);
    }
    parts.push("");
  }
  return parts.join("\n");
}

function fillTemplate(tpl, vars) {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(String(v));
  }
  if (!tpl.includes("{{ISSUES}}")) out += "\n\n" + vars.ISSUES;
  return out;
}

/* ---------- UI ---------- */

function setStatus(msg, kind) {
  const el = $("status");
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
  el.hidden = !msg;
}

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function generate() {
  const btn = $("generate");
  btn.disabled = true;
  $("output").hidden = true;
  setStatus("Récupération des issues…", "info");
  try {
    const opts = readOptsFromUi();
    await browser.storage.local.set(opts);

    const tab = await getActiveTab();
    if (!tab || !tab.url || !/^https?:/i.test(tab.url)) {
      throw new Error(
        "Cet onglet n'est pas une page web classique. Ouvre la page « Issues » de ton SonarQube puis réessaie."
      );
    }
    const base = deriveSonarBase(tab.url);
    const { query, projectKey } = buildQuery(tab.url, opts.useFilters);
    lastProject = projectKey;

    let results;
    try {
      results = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: collectIssues,
        args: [base, query, opts.maxIssues],
      });
    } catch (e) {
      throw new Error("Impossible d'accéder à cet onglet (" + (e.message || e) + ").");
    }
    const data = results && results[0] ? results[0].result : null;
    if (!data) throw new Error("Aucune réponse du script injecté.");
    if (!data.ok) {
      if (data.status === 401 || data.status === 403) {
        throw new Error(
          `Accès refusé par l'API SonarQube (HTTP ${data.status}). Connecte-toi à SonarQube dans cet onglet puis réessaie.`
        );
      }
      if (data.status === 404) {
        throw new Error(
          `API introuvable à « ${base}/api » — cette page ne semble pas être un SonarQube.`
        );
      }
      throw new Error("Échec de la récupération : " + (data.error || "erreur inconnue"));
    }
    if (data.issues.length === 0) {
      setStatus("Aucune issue trouvée avec ces filtres. 🎉", "ok");
      return;
    }

    const body =
      opts.grouping === "file"
        ? renderByFile(data.issues, data.components)
        : renderByRule(data.issues, data.components);
    let issuesText = body.trimEnd();
    if (data.total > data.issues.length) {
      issuesText += `\n\n> Note : ${data.issues.length} issues listées sur ${data.total} au total (augmente « Nombre max d'issues » ou affine les filtres SonarQube pour le reste).`;
    }

    const project = projectKey || new URL(base).host;
    const prompt = fillTemplate(opts.template, {
      PROJECT: project,
      COUNT: data.issues.length,
      TOTAL: data.total,
      ISSUES: issuesText,
    });

    $("result").value = prompt;
    $("stats").textContent =
      `${data.issues.length} issue(s) • ${prompt.length.toLocaleString("fr-FR")} caractères • ` +
      `≈ ${Math.round(prompt.length / 4).toLocaleString("fr-FR")} tokens`;
    $("output").hidden = false;
    setStatus("Prompt généré ✅", "ok");
  } catch (e) {
    setStatus(e.message || String(e), "error");
  } finally {
    btn.disabled = false;
  }
}

async function copyResult() {
  const text = $("result").value;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    $("result").select();
    document.execCommand("copy");
  }
  const btn = $("copy");
  const prev = btn.textContent;
  btn.textContent = "Copié ✓";
  setTimeout(() => (btn.textContent = prev), 1500);
}

function downloadResult() {
  const blob = new Blob([$("result").value], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `sonar-prompt${lastProject ? "-" + lastProject.replace(/[^\w.-]+/g, "_") : ""}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function init() {
  const opts = await browser.storage.local.get(DEFAULT_OPTS);
  $("grouping").value = opts.grouping;
  $("maxIssues").value = opts.maxIssues;
  $("useFilters").checked = opts.useFilters;
  $("template").value = opts.template;

  for (const id of ["grouping", "maxIssues", "useFilters", "template"]) {
    $(id).addEventListener("change", saveOpts);
  }
  $("generate").addEventListener("click", generate);
  $("copy").addEventListener("click", copyResult);
  $("download").addEventListener("click", downloadResult);
  $("resetTemplate").addEventListener("click", () => {
    $("template").value = DEFAULT_TEMPLATE;
    saveOpts();
  });

  try {
    const tab = await getActiveTab();
    if (tab && tab.url && /^https?:/i.test(tab.url)) {
      const base = deriveSonarBase(tab.url);
      const id = new URL(tab.url).searchParams.get("id");
      $("context").textContent = id
        ? `Instance : ${new URL(base).host} • Projet : ${id}`
        : `Instance : ${new URL(base).host}`;
    } else {
      $("context").textContent =
        "Ouvre la page « Issues » de ton projet SonarQube, puis clique sur « Générer le prompt ».";
    }
  } catch {
    $("context").textContent = "";
  }
}

document.addEventListener("DOMContentLoaded", init);
