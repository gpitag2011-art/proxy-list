#!/usr/bin/env node
"use strict";

/**
 * Build offline release assets + release notes for the current docs/data.json.
 *
 *   node scripts/build_offline_release.js --out dist [--prev-ref <git ref>] [--prev-tag <tag>]
 *
 * Assets are produced by docs/offline-export.js (same code as the site's
 * "Download offline copy" dialog), with fetch() served from the local checkout.
 *
 * Notes: new version → the site's Update Notice (changelog);
 *        revision    → links added/removed vs the previous release.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DOCS = path.join(ROOT, "docs");
const LIVE_URL = "https://yourworstnightmare1.github.io/proxy-list";
const FOOTER =
  "Update live at " +
  LIVE_URL +
  ", or download the offline version using the files below (HTML full version recommended).";

function parseArgs(argv) {
  const out = { out: "dist", prevRef: "", prevTag: "" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] || "";
    if (a === "--out") out.out = next();
    else if (a === "--prev-ref") out.prevRef = next();
    else if (a === "--prev-tag") out.prevTag = next();
    else throw new Error("Unknown argument: " + a);
  }
  if (!out.prevRef) out.prevRef = out.prevTag;
  return out;
}

function loadDataLoader() {
  const sandbox = {
    URL,
    console,
    document: { getElementsByTagName: () => [], baseURI: "file:///" },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(DOCS, "data-loader.js"), "utf8"), sandbox);
  return sandbox.ProxyListData;
}

function expandPayload(loader, json) {
  const normalized = loader.normalizePayload(json);
  const links = normalized.compact
    ? loader.expandAllLinks({
        format: 2,
        providers: normalized.compact.providers,
        contributors: normalized.compact.contributors,
        links: normalized.compact.links,
      })
    : normalized.links || [];
  return {
    meta: normalized.meta || {},
    link_check: normalized.link_check || {},
    failing_links: normalized.failing_links,
    links,
  };
}

function gitShowJson(ref, file) {
  if (!ref) return null;
  try {
    const raw = execFileSync("git", ["show", ref + ":" + file], {
      cwd: ROOT,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(raw.toString("utf8"));
  } catch (_) {
    return null;
  }
}

function versionFromTag(tag) {
  const m = /^(v[\d.]+)r\d+$/i.exec(String(tag || "").trim());
  return m ? m[1] : "";
}

function linkUrlSet(links) {
  const set = new Set();
  for (const row of links || []) {
    const url = String((row && row.link) || "").trim();
    if (url) set.add(url);
  }
  return set;
}

function plural(n, word) {
  return n.toLocaleString("en-US") + " " + word + (n === 1 ? "" : "s");
}

function buildNotes({ data, prevData, prevTag }) {
  const meta = data.meta || {};
  const version = String(meta.version || "").trim();
  const prevVersion = String((prevData && prevData.meta && prevData.meta.version) || "").trim() || versionFromTag(prevTag);
  const isNewVersion = !prevVersion || prevVersion !== version;
  const lines = [];

  if (isNewVersion) {
    const changelog = String(meta.update_notice || "").replace(/\r\n/g, "\n").trim();
    lines.push(changelog || "_No changelog was published for this version._");
  } else {
    const cur = linkUrlSet(data.links);
    const prev = prevData ? linkUrlSet(prevData.links) : null;
    if (prev) {
      let added = 0;
      let removed = 0;
      cur.forEach((u) => {
        if (!prev.has(u)) added++;
      });
      prev.forEach((u) => {
        if (!cur.has(u)) removed++;
      });
      lines.push(
        plural(added, "link") +
          " added, " +
          plural(removed, "link") +
          " removed, new total: " +
          cur.size.toLocaleString("en-US") +
          " (old total: " +
          prev.size.toLocaleString("en-US") +
          ")"
      );
    } else {
      lines.push("New total: " + cur.size.toLocaleString("en-US") + " links");
    }
  }

  lines.push("", "---", "", FOOTER, "");
  return { notes: lines.join("\n"), isNewVersion };
}

function makeLocalFetch(listMdRawUrl) {
  return async function localFetch(url) {
    const s = String(url);
    let file;
    if (s === listMdRawUrl || /\/list\.md$/.test(s)) file = path.join(ROOT, "list.md");
    else if (/^https?:/i.test(s)) throw new Error("Unexpected network fetch during release build: " + s);
    else file = path.join(DOCS, s.replace(/^\.?\//, ""));
    if (!fs.existsSync(file)) {
      return { ok: false, status: 404, headers: { get: () => null }, body: null, text: async () => "" };
    }
    const text = fs.readFileSync(file, "utf8");
    return { ok: true, status: 200, headers: { get: () => null }, body: null, text: async () => text };
  };
}

function loadOfflineExporter(data, linklens) {
  const noopEl = null;
  const sandbox = {
    URL,
    console,
    TextDecoder,
    Blob,
    setTimeout,
    clearTimeout,
    fetch: makeLocalFetch("https://raw.githubusercontent.com/yourworstnightmare1/proxy-list/main/list.md"),
    document: {
      readyState: "complete",
      getElementById: () => noopEl,
      addEventListener: () => {},
    },
    __proxyListPageContext: { meta: data.meta, link_check: data.link_check, links: data.links },
    __proxyListLinkLensHydrated: !!linklens,
    __proxyListLinkLensData: linklens,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(DOCS, "offline-export.js"), "utf8"), sandbox);
  const api = sandbox.ProxyListOfflineExport;
  if (!api || !api.build) throw new Error("offline-export.js does not expose build helpers");
  return api.build;
}

async function main() {
  const args = parseArgs(process.argv);
  const loader = loadDataLoader();
  const data = expandPayload(loader, JSON.parse(fs.readFileSync(path.join(DOCS, "data.json"), "utf8")));
  const meta = data.meta || {};
  const tag = String(meta.version || "").trim() + String(meta.revision || "").trim();
  if (!tag) throw new Error("docs/data.json meta is missing version/revision");

  const prevJson = gitShowJson(args.prevRef, "docs/data.json");
  const prevData = prevJson ? expandPayload(loader, prevJson) : null;
  const { notes, isNewVersion } = buildNotes({ data, prevData, prevTag: args.prevTag });

  const linklensPath = path.join(DOCS, "linklens.json");
  const linklens = fs.existsSync(linklensPath) ? JSON.parse(fs.readFileSync(linklensPath, "utf8")) : null;
  const build = loadOfflineExporter(data, linklens);

  const outDir = path.resolve(ROOT, args.out);
  fs.mkdirSync(outDir, { recursive: true });
  // proxy-list-[version][revision]-[type].[format]; the workflow zips each as ...-[type]-[format].zip.
  // .md is the complete formatted list (full); .txt is URLs only (lite).
  const assets = [
    ["proxy-list-" + tag + "-full.html", () => build.html("full")],
    ["proxy-list-" + tag + "-lite.html", () => build.html("lite")],
    ["proxy-list-" + tag + "-full.md", () => build.markdown()],
    ["proxy-list-" + tag + "-lite.txt", () => build.text()],
  ];
  for (const [name, make] of assets) {
    const content = await make();
    fs.writeFileSync(path.join(outDir, name), content, "utf8");
    console.log("wrote " + name + " (" + (Buffer.byteLength(content) / 1048576).toFixed(2) + " MB)");
  }
  fs.writeFileSync(path.join(outDir, "RELEASE_NOTES.md"), notes, "utf8");
  console.log("tag=" + tag + " kind=" + (isNewVersion ? "version" : "revision") + " prev=" + (args.prevRef || "(none)"));
  console.log("---\n" + notes);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
