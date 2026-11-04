import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, hc, home, readTextFile, theme, settings, props, closeOverlay } from "herdr";

const FIELDS = "number,title,state,isDraft,url,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,additions,deletions,changedFiles,author,statusCheckRollup,files,autoMergeRequest,comments,assignees,reviewRequests,latestReviews";
const DEFAULT_MARKER = "<!-- herdr-pr-preview -->";
const SETTINGS_FILE = "mods/pull-request/settings.json";
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
const STALE_MS = 30000;
const METHODS = [["squash", "squashMergeAllowed", "Squash and merge"], ["merge", "mergeCommitAllowed", "Merge commit"], ["rebase", "rebaseMergeAllowed", "Rebase and merge"]];
const TRUNKS = ["main", "master", "HEAD"];
const ORDER = { fail: 0, pending: 1, pass: 2, skip: 3 };
const FADE = { duration: 160, easing: "ease-out" };

function focusedPane() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { pane, cwd: pane?.cwd || f?.cwd || space?.folder, on };
}

function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

function splitDiff(text) {
  const byPath = {};
  for (const chunk of text.split(/^diff --git /m).slice(1)) {
    const lines = chunk.replace(/\n$/, "").split("\n");
    const target = lines.find((l) => l.startsWith("+++ "));
    const path = target && target !== "+++ /dev/null" ? target.slice(6) : (lines.find((l) => l.startsWith("--- a/"))?.slice(6) ?? lines[0].split(" b/").pop());
    const first = lines.findIndex((l) => l.startsWith("@@"));
    byPath[path] = first < 0 ? ["Binary or empty change · no text diff"] : lines.slice(first);
  }
  return byPath;
}

function checkOf(c) {
  if (c.__typename === "StatusContext") {
    const s = c.state;
    return { name: c.context, group: "", url: c.targetUrl, result: s === "SUCCESS" ? "pass" : s === "PENDING" || s === "EXPECTED" ? "pending" : "fail" };
  }
  const done = c.status === "COMPLETED", ok = ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion);
  return { name: c.name, group: c.workflowName ?? "", url: c.detailsUrl, result: !done ? "pending" : ok ? (c.conclusion === "SUCCESS" ? "pass" : "skip") : "fail" };
}

function worstCheck(rollup) {
  const checks = (rollup ?? []).map(checkOf);
  if (checks.some((k) => k.result === "fail")) return "fail";
  if (checks.some((k) => k.result === "pending")) return "pending";
  return checks.length ? "pass" : null;
}

function previewOf(pr, marker) {
  const comment = [...(pr.comments ?? [])].reverse().find((c) => String(c.body ?? "").includes(marker));
  if (!comment) return null;
  const lines = String(comment.body).split("\n");
  const commit = /`([0-9a-f]{7,40})`/.exec(comment.body)?.[1] ?? null;
  const rows = [];
  lines.forEach((line, i) => {
    const cells = /^\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
    const isSeparator = (l) => /^\|[\s:|-]+\|\s*$/.test(l ?? "");
    if (!cells || isSeparator(line) || isSeparator(lines[i + 1])) return;
    const link = /\[([^\]]+)\]\(([^)]+)\)/.exec(cells[2]);
    rows.push({ name: cells[1], url: link?.[2] ?? null, note: link ? null : cells[2].replace(/\*/g, "") });
  });
  return { rows, commit };
}

const fail = (r) => new Error((r.stderr || r.stdout || "failed").trim());
const parse = (r) => (r.code === 0 ? JSON.parse(r.stdout) : null);

export default class PullRequest extends View {
  init(_props, cx) {
    this.tab = "checks"; this.rows = []; this.diffWidth = 0;
    this.cache = new Map();
    this.methodsByRepo = new Map();
    this.marker = DEFAULT_MARKER;
    this.loadSettings(cx);
    this.resolveGh(cx);
    cx.timer.every(500, (cx) => this.tick(cx));
  }

  loadSettings(cx) {
    cx.spawn(async (cx) => {
      const text = await readTextFile(`${home()}/.config/herdr-app/${SETTINGS_FILE}`).catch(() => null);
      try { this.marker = JSON.parse(text)?.previewMarker || DEFAULT_MARKER; } catch { this.marker = DEFAULT_MARKER; }
      cx.notify();
    });
  }

  resolveGh(cx) {
    cx.spawn(async (cx) => {
      for (const path of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", `${home()}/.local/bin/gh`]) {
        if ((await exec("test", ["-x", path]).catch(() => ({ code: 1 }))).code === 0) { this.gh = path; break; }
      }
      if (!this.gh) {
        const r = await exec("sh", ["-lc", "command -v gh"]).catch(() => null);
        this.gh = r?.code === 0 ? r.stdout.trim() : null;
      }
      this.tick(cx, true);
    });
  }

  async agentCwd(pane, on) {
    if (on || !pane?.terminal || pane.terminal.includes("/") || !pane.program?.agent) return null;
    const info = parse(await hc(["get", pane.terminal, "--json"]).catch(() => ({ code: 1 })));
    if (!info?.pid) return null;
    const kids = await exec("pgrep", ["-P", String(info.pid)]).catch(() => ({ stdout: "" }));
    for (const pid of kids.stdout.split("\n").filter(Boolean)) {
      const session = await readTextFile(`${home()}/.claude/sessions/${pid}.json`).catch(() => null);
      if (!session) continue;
      const { sessionId } = JSON.parse(session);
      const tail = await exec("sh", ["-c", 'tail -c 300000 "$1"/*/"$2".jsonl 2>/dev/null', "sh", `${home()}/.claude/projects`, sessionId]).catch(() => ({ stdout: "" }));
      for (const line of tail.stdout.split("\n").reverse()) {
        try { const cwd = JSON.parse(line).cwd; if (cwd) return cwd; } catch {}
      }
    }
    return null;
  }

  async branchOf(root, on) {
    const r = await exec("git", [...READ, "rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, on });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async topOf(cwd, on) {
    const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  tick(cx, force = false, redetect = force) {
    if (this.gh === undefined || this.loading || this.busy) return;
    if (!force && Date.now() - (this.lastRun ?? 0) < STALE_MS) return;
    const detect = redetect || !this.target;
    const focus = detect ? focusedPane() : null;
    if (detect && !focus.cwd) return;
    this.lastRun = Date.now();
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (detect) this.target = { cwd: (await this.agentCwd(focus.pane, focus.on)) ?? focus.cwd, on: focus.on };
        const { cwd, on } = this.target;
        const own = await this.topOf(cwd, on);
        const place = JSON.stringify([on, own ?? cwd]);
        if (place !== this.place) { this.place = place; this.picked = null; this.listing = false; }
        const folder = own ? own.replace(/\/[^/]+$/, "") : await this.workspaceOf(cwd, on);
        const scope = JSON.stringify([on, folder]);
        if (scope !== this.scope) { this.scope = scope; this.candidates = null; this.scanned = 0; }
        if (!this.gh) { this.error = "gh CLI not found"; return; }
        const branch = !this.picked && !this.listing && own ? await this.branchOf(own, on) : null;
        const root = this.picked?.root ?? own;
        const ref = this.picked ? `#${this.picked.pr.number}` : branch && !TRUNKS.includes(branch) ? branch : null;
        const key = root && ref ? JSON.stringify([on, root, ref]) : null;
        if (key !== this.key || root !== this.root) {
          this.key = key; this.root = root; this.on = on; this.branch = this.picked?.branch ?? branch;
          this.open = null; this.rows = []; this.note = null; this.confirm = null; this.error = null;
          cx.notify();
        }
        if (key) {
          const entry = this.cache.get(key);
          if (force || !entry || Date.now() - entry.fetched > STALE_MS) await this.fetchPr(key, this.picked?.pr.number, cx);
          if (this.cache.get(key)?.pr) { if (this.tab === "files") await this.ensureDiff(key, cx); return; }
        }
        if (force || !this.candidates || Date.now() - this.scanned > STALE_MS) await this.scan([...new Set([...(own ? [own] : []), ...(await this.reposBelow(folder, on))])], on, scope, cx);
        if (!this.candidates) this.error = "No git repository here or in its subfolders";
      } catch (e) { this.error = String(e.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  ghIn(root, args) {
    return exec(this.gh, args, { cwd: root, on: this.on });
  }

  async fetchPr(key, number, cx) {
    const root = this.root;
    const repoKnown = this.methodsByRepo.has(root);
    const [view, repo] = await Promise.all([
      this.ghIn(root, ["pr", "view", ...(number ? [String(number)] : []), "--json", FIELDS]),
      repoKnown ? null : this.ghIn(root, ["repo", "view", "--json", METHODS.map((m) => m[1]).join(",")]),
    ]);
    if (repo) {
      const allowed = parse(repo) ?? {};
      const methods = METHODS.filter((m) => allowed[m[1]]);
      this.methodsByRepo.set(root, methods.length ? methods : [METHODS[0]]);
    }
    if (view.code !== 0 && !/no pull requests found/i.test(view.stderr)) throw fail(view);
    const previous = this.cache.get(key);
    const pr = parse(view);
    const sameHead = previous?.pr && pr && previous.pr.headRefOid === pr.headRefOid;
    this.cache.set(key, { pr, fetched: Date.now(), diff: sameHead ? previous.diff : null });
    if (!this.method || !this.methodsByRepo.get(root)?.some((m) => m[0] === this.method)) this.method = this.methodsByRepo.get(root)?.[0]?.[0];
    if (key === this.key) cx.notify();
  }

  async ensureDiff(key, cx) {
    const entry = this.cache.get(key);
    if (!entry?.pr || entry.diff) return;
    const d = await this.ghIn(this.root, ["pr", "diff", String(entry.pr.number), "--color=never"]);
    entry.diff = d.code === 0 ? splitDiff(d.stdout) : {};
    if (key === this.key && this.open) this.show(this.open);
    cx.notify();
  }

  async workspaceOf(cwd, on) {
    for (let dir = cwd; dir.startsWith(`${home()}/`); dir = dir.replace(/\/[^/]+$/, "")) {
      if ((await this.reposBelow(dir, on)).length) return dir;
    }
    return cwd;
  }

  async reposBelow(folder, on) {
    const r = await exec("find", [folder, "-mindepth", "2", "-maxdepth", "2", "-name", ".git"], { on });
    return r.stdout.split("\n").filter(Boolean).map((p) => p.slice(0, -5)).sort();
  }

  async scan(roots, on, scope, cx) {
    this.scanning = true;
    cx.notify();
    try {
      const clones = await Promise.all(roots.map(async (root) => {
        const remote = await exec("git", ["remote", "get-url", "origin"], { cwd: root, on });
        const slug = /github\.com[:/](.+?)(?:\.git)?$/.exec(remote.stdout.trim())?.[1];
        return slug ? { root, slug, branch: await this.branchOf(root, on) } : null;
      }));
      const bySlug = new Map();
      for (const c of clones.filter(Boolean)) bySlug.set(c.slug, [...(bySlug.get(c.slug) ?? []), c]);
      const lists = await Promise.all([...bySlug].map(async ([slug, local]) => {
        const r = await exec(this.gh, ["pr", "list", "--repo", slug, "--author", "@me", "--state", "open", "--json", "number,title,isDraft,headRefName,statusCheckRollup,url,reviewDecision,latestReviews"], { cwd: local[0].root, on });
        const base = local.find((c) => TRUNKS.includes(c.branch)) ?? local[0];
        return (parse(r) ?? []).map((pr) => {
          const tree = local.find((c) => c.branch === pr.headRefName);
          return { root: (tree ?? base).root, repo: slug.split("/").pop(), local: tree ? tree.root.split("/").pop() : null, branch: pr.headRefName, pr };
        });
      }));
      if (scope !== this.scope) return;
      this.candidates = bySlug.size ? lists.flat().sort((a, b) => Number(Boolean(b.local)) - Number(Boolean(a.local)) || a.repo.localeCompare(b.repo) || b.pr.number - a.pr.number) : null;
      this.scanned = Date.now();
      this.error = null;
    } finally { this.scanning = false; }
  }

  choose(candidate, cx) {
    this.picked = candidate ?? null; this.seed = candidate ?? null; this.listing = !candidate; this.tab = "checks";
    this.loading = false;
    this.tick(cx, true, false);
    cx.notify();
  }

  switchTab(id, cx) {
    this.tab = id;
    if (id === "files" && this.key) cx.spawn(async (cx) => { await this.ensureDiff(this.key, cx); });
    cx.notify();
  }

  show(path) {
    const diff = this.cache.get(this.key)?.diff;
    const lines = (diff?.[path] ?? ["No text diff available"]).slice(0, 3000).map((l) => (l.length > 4000 ? l.slice(0, 4000) + "… (line truncated)" : l));
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map((l) => l.length * 7 + 50));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path;
    if (this.open && this.cache.get(this.key)?.diff) this.show(path); else this.rows = [];
    cx.notify();
  }

  act(name, args, cx) {
    if (this.busy) return;
    if (this.confirm !== name) { this.confirm = name; cx.notify(); return; }
    this.confirm = null; this.busy = name; this.note = null;
    const key = this.key, root = this.root;
    cx.spawn(async (cx) => {
      try {
        const r = await this.ghIn(root, args);
        if (r.code !== 0) throw fail(r);
        if (key === this.key) await this.fetchPr(key, this.picked?.pr.number, cx);
      } catch (e) { if (key === this.key) this.note = String(e.message ?? e); }
      finally { this.busy = null; cx.notify(); }
    });
    cx.notify();
  }

  browse(url) {
    if (url) exec("open", [url]);
  }

  progress(t) {
    const active = Boolean(this.loading || this.busy || this.scanning);
    return div().id("pr-progress").relative().h(2).flex_none().w_full().overflow_hidden()
      .opacity(active ? 1 : 0).transition("opacity", FADE)
      .child(div().absolute().top(0).h(2).w(90).rounded(1).bg(t.accent).loop("left", { from: -90, to: 420, period: 1100 }));
  }

  bone(id, width, height, t) {
    return div().id(id).h(height).w(width).flex_none().rounded(4).bg(t.raised).loop("opacity", { from: 0.35, to: 0.9, period: 1100 });
  }

  skeletonRows(prefix, count, t) {
    return Array.from({ length: count }, (_, i) => h_flex().h(28).flex_none().px(8).gap(8).items_center()
      .child(this.bone(`${prefix}-dot-${i}`, 12, 12, t))
      .child(this.bone(`${prefix}-line-${i}`, `${55 + ((i * 17) % 35)}%`, 10, t)));
  }

  skeletonDetail(t) {
    const seed = this.seed && this.seed.root === this.root ? this.seed.pr : null;
    return v_flex().flex_1().min_h(0)
      .child(v_flex().flex_none().px(14).py(10).gap(8).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).items_center()
          .child(seed ? div().text_color(t.dim).child(`#${seed.number}`) : this.bone("sk-num", 34, 12, t))
          .child(this.bone("sk-badge", 42, 14, t)))
        .child(seed ? div().font_semibold().whitespace_normal().child(seed.title) : this.bone("sk-title", "85%", 14, t))
        .child(this.bone("sk-refs", "60%", 10, t))
        .child(this.bone("sk-merge", "45%", 10, t)))
      .child(h_flex().flex_none().px(10).py(8).gap(6).border_b(1).border_color(t.border)
        .child(this.bone("sk-tab1", 70, 18, t)).child(this.bone("sk-tab2", 60, 18, t)))
      .child(v_flex().flex_1().min_h(0).p(6).children(this.skeletonRows("sk-check", 7, t)));
  }

  badge(text, color) {
    return div().px(6).py(1).rounded(4).border_1().border_color(color).text_size(10.5).text_color(color).child(text);
  }

  stateBadge(pr, t) {
    if (pr.state === "MERGED") return this.badge("Merged", t.ansi5);
    if (pr.state === "CLOSED") return this.badge("Closed", t.ansi1);
    if (pr.isDraft) return this.badge("Draft", t.dim);
    return this.badge("Open", t.ansi2);
  }

  mergeLine(pr, t) {
    const status = {
      CLEAN: ["Ready to merge", t.ansi2], UNSTABLE: ["Ready to merge · some checks failed", t.ansi3], HAS_HOOKS: ["Ready to merge", t.ansi2],
      BLOCKED: ["Blocked · required checks or reviews missing", t.ansi3], BEHIND: ["Branch is behind its base", t.ansi3],
      DIRTY: ["Merge conflicts", t.ansi1], DRAFT: ["Draft", t.dim], UNKNOWN: ["Checking mergeability…", t.dim],
    }[pr.mergeStateStatus] ?? [pr.mergeStateStatus, t.dim];
    return h_flex().gap(8).text_size(11.5)
      .child(div().text_color(status[1]).child(status[0]))
      .when(Boolean(pr.autoMergeRequest), (el) => el.child(div().text_color(t.accent).child("· Auto-merge on")));
  }

  peopleLine(label, people, t) {
    return h_flex().gap(6).items_center().flex_wrap().text_size(11.5)
      .child(div().w(64).flex_none().text_color(t.dim).child(label))
      .when(!people.length, (el) => el.child(div().text_color(t.dim).child("None")))
      .children(people.map(([glyph, name, color]) => h_flex().gap(3).child(div().text_color(color).child(glyph)).child(div().text_color(t.foreground).child(name))));
  }

  approval(pr, t) {
    const approvals = (pr.latestReviews ?? []).filter((r) => r.state === "APPROVED").length;
    return {
      APPROVED: ["Approved", t.ansi2], CHANGES_REQUESTED: ["Changes requested", t.ansi1], REVIEW_REQUIRED: ["Review required", t.ansi3],
    }[pr.reviewDecision] ?? [approvals ? `${approvals} approval${approvals > 1 ? "s" : ""}` : "No approval yet", approvals ? t.ansi2 : t.dim];
  }

  approvalTag(pr, t) {
    const [text, color] = this.approval(pr, t);
    return div().flex_none().text_size(11).text_color(color).child(text);
  }

  reviewLines(pr, t) {
    const verdict = { APPROVED: ["✓", t.ansi2], CHANGES_REQUESTED: ["✕", t.ansi1], COMMENTED: ["◦", t.dim], DISMISSED: ["–", t.dim] };
    const reviewed = (pr.latestReviews ?? []).filter((r) => r.author?.login).map((r) => {
      const [glyph, color] = verdict[r.state] ?? verdict.COMMENTED;
      return [glyph, r.author.login, color];
    });
    const requested = (pr.reviewRequests ?? []).map((r) => ["○", r.login ?? r.name ?? r.slug, t.ansi3])
      .filter(([, name]) => !reviewed.some(([, n]) => n === name));
    const [text, color] = this.approval(pr, t);
    const assignees = (pr.assignees ?? []).map((a) => ["", a.login, t.foreground]);
    return v_flex().gap(4)
      .child(h_flex().gap(6).items_center().text_size(11.5)
        .child(div().w(64).flex_none().text_color(t.dim).child("Approval"))
        .child(div().text_color(color).child(text)))
      .child(this.peopleLine("Reviewers", [...reviewed, ...requested], t))
      .child(this.peopleLine("Assignees", assignees, t));
  }

  mark(result, t) {
    if (result === "pending") return h_flex().w(14).flex_none().items_center().child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.ansi3).spin(800));
    const [glyph, color] = { pass: ["✓", t.ansi2], fail: ["✕", t.ansi1], skip: ["–", t.dim] }[result] ?? ["", t.dim];
    return div().w(14).flex_none().text_color(color).child(glyph);
  }

  checkRow(c, i, t) {
    return h_flex().id(`check-${i}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7)
      .when(Boolean(c.url), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.browse(c.url)))
      .child(this.mark(c.result, t))
      .child(div().flex_1().min_w(0).truncate().child(c.name))
      .when(Boolean(c.group), (el) => el.child(div().max_w(140).truncate().text_size(11).text_color(t.dim).child(c.group)));
  }

  fileRow(f, t) {
    const parts = f.path.split("/"), name = parts.pop();
    const mark = { ADDED: "A", DELETED: "D", RENAMED: "R" }[f.changeType] ?? "M";
    const color = mark === "A" ? t.git_add ?? t.ansi2 : mark === "D" ? t.git_delete ?? t.ansi1 : t.git_change ?? t.blocked;
    return h_flex().id(`pr-file-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
      .when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
      .child(div().w(14).text_size(11).text_color(color).child(mark))
      .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
      .when(f.additions > 0, (e) => e.child(div().text_size(11).text_color(t.git_add ?? t.ansi2).child(`+${f.additions}`)))
      .when(f.deletions > 0, (e) => e.child(div().text_size(11).text_color(t.git_delete ?? t.ansi1).child(`−${f.deletions}`)));
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.diff_add ?? t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.diff_delete ?? t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  tabButton(id, label, t) {
    const on = this.tab === id;
    return div().id(`pr-tab-${id}`).h(26).px(10).flex().items_center().rounded(6).cursor_pointer().text_size(12)
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.switchTab(id, cx)).child(label);
  }

  button(id, label, primary, t, action) {
    const armed = this.confirm === id, idle = !this.busy;
    return div().id(`pr-${id}`).h(32).px(14).flex().items_center().gap(6).rounded(8).text_size(12)
      .bg(armed ? t.ansi3 : primary ? t.solid : t.raised).text_color(armed || primary ? t.solid_foreground : t.foreground)
      .opacity(idle ? 1 : 0.6).transition("opacity", FADE)
      .when(idle, (e) => e.cursor_pointer().on_click((_e, cx) => action(cx)))
      .when(this.busy === id, (e) => e.child(div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 80)))
      .child(this.busy === id ? "Working…" : armed ? `Confirm: ${label}` : label);
  }

  footer(pr, t) {
    const n = String(pr.number), methods = this.methodsByRepo.get(this.root) ?? [METHODS[0]];
    const method = methods.find((m) => m[0] === this.method) ?? methods[0];
    const cycle = (cx) => {
      if (methods.length < 2) return;
      const i = methods.findIndex((m) => m[0] === method[0]);
      this.method = methods[(i + 1) % methods.length][0]; this.confirm = null; cx.notify();
    };
    const ready = ["CLEAN", "UNSTABLE", "HAS_HOOKS"].includes(pr.mergeStateStatus);
    const bar = h_flex().flex_none().p(10).gap(8).items_center().border_t(1).border_color(t.border);
    if (pr.isDraft) return bar.child(div().flex_1()).child(this.button("ready", "Ready for review", true, t, (cx) => this.act("ready", ["pr", "ready", n], cx)));
    return bar
      .child(div().id("pr-method").h(32).px(10).flex().items_center().rounded(8).border_1().border_color(t.border).text_size(12).text_color(t.muted)
        .when(methods.length > 1, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => cycle(cx)).child(method[2]))
      .child(div().flex_1())
      .child(this.button("draft", "Make draft", false, t, (cx) => this.act("draft", ["pr", "ready", n, "--undo"], cx)))
      .when(Boolean(pr.autoMergeRequest), (el) => el.child(this.button("auto-off", "Disable auto-merge", false, t, (cx) => this.act("auto-off", ["pr", "merge", n, "--disable-auto"], cx))))
      .when(!pr.autoMergeRequest && !ready && pr.mergeStateStatus !== "DIRTY", (el) => el.child(this.button("auto", "Enable auto-merge", false, t, (cx) => this.act("auto", ["pr", "merge", n, `--${method[0]}`, "--auto"], cx))))
      .when(ready, (el) => el.child(this.button("merge", "Merge", true, t, (cx) => this.act("merge", ["pr", "merge", n, `--${method[0]}`], cx))));
  }

  filesPane(pr, entry, t) {
    const files = pr.files ?? [];
    return v_flex().flex_1().min_h(0)
      .child(v_flex().id("pr-files").flex_none().h(Math.min(200, Math.max(44, files.length * 28 + 12))).overflow_y_scrollbar().p(6).border_b(1).border_color(t.border)
        .children(files.map((f) => this.fileRow(f, t))))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .when(Boolean(this.open && entry.diff), (el) => el
          .child(div().id(`pr-diff-x-${this.open}`).size_full().overflow_x_scrollbar().opacity(1).transition("opacity", FADE)
            .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("pr-diff", this.rows.length, 20, (i) => String(i),
              (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
          .child(Scrollbar.vertical("pr-diff").viewport_from_layout().absolute().inset_0()))
        .when(Boolean(this.open && !entry.diff), (el) => el.child(v_flex().p(10).gap(6)
          .children(Array.from({ length: 12 }, (_, i) => this.bone(`sk-diff-${i}`, `${40 + ((i * 23) % 55)}%`, 10, t)))))
        .when(!this.open, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its diff"))));
  }

  previewLine(pr, preview, t) {
    const stale = preview.commit && pr.headRefOid && !pr.headRefOid.startsWith(preview.commit);
    return v_flex().gap(4)
      .child(h_flex().gap(6).items_center().text_size(11.5)
        .child(div().text_color(t.dim).child("Preview"))
        .when(Boolean(stale), (el) => el.child(div().text_color(t.ansi3).child(`· built for ${preview.commit}, not the latest commit`))))
      .child(h_flex().flex_wrap().gap(6)
        .children(preview.rows.map((row, i) => row.url
          ? div().id(`pr-preview-${i}`).h(24).px(9).flex().items_center().gap(4).rounded(6).border_1().border_color(t.border).cursor_pointer()
            .text_size(12).text_color(t.foreground).hover((s) => s.bg(t.hover)).tooltip(row.url).on_click(() => this.browse(row.url)).child(`${row.name} ↗`)
          : h_flex().h(24).px(9).gap(5).items_center().rounded(6).bg(t.raised).text_size(12).text_color(t.dim)
            .when(/build|deploy|pending|progress/i.test(row.note), (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.ansi3).spin(800)))
            .child(`${row.name} · ${row.note}`))));
  }

  detail(pr, entry, t) {
    const preview = previewOf(pr, this.marker);
    const checks = (pr.statusCheckRollup ?? []).map(checkOf).sort((a, b) => ORDER[a.result] - ORDER[b.result] || a.name.localeCompare(b.name));
    const count = (r) => checks.filter((c) => c.result === r).length;
    const summary = [[count("fail"), "failed", t.ansi1], [count("pending"), "pending", t.ansi3], [count("pass"), "passed", t.ansi2]].filter(([n]) => n > 0);
    return v_flex().flex_1().min_h(0)
      .child(v_flex().flex_none().px(14).py(10).gap(6).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).items_center()
          .child(div().text_color(t.dim).child(`#${pr.number}`))
          .child(this.stateBadge(pr, t))
          .child(div().flex_1())
          .child(div().id("pr-browse").px(6).py(2).rounded(5).cursor_pointer().text_size(11.5).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click(() => this.browse(pr.url)).child("GitHub ↗")))
        .child(div().font_semibold().whitespace_normal().child(pr.title))
        .child(h_flex().gap(6).text_size(11.5).text_color(t.dim)
          .child(div().max_w(150).truncate().child(pr.baseRefName)).child(div().child("←")).child(div().flex_1().min_w(0).truncate().child(pr.headRefName))
          .child(div().text_color(t.git_add ?? t.ansi2).child(`+${pr.additions}`)).child(div().text_color(t.git_delete ?? t.ansi1).child(`−${pr.deletions}`)))
        .when(pr.state === "OPEN", (el) => el.child(this.mergeLine(pr, t)))
        .child(this.reviewLines(pr, t))
        .when(Boolean(preview?.rows.length), (el) => el.child(this.previewLine(pr, preview, t))))
      .child(h_flex().flex_none().px(10).py(6).gap(4).items_center().border_b(1).border_color(t.border)
        .child(this.tabButton("checks", `Checks ${checks.length}`, t))
        .child(this.tabButton("files", `Files ${pr.changedFiles}`, t))
        .child(div().flex_1())
        .children(summary.map(([n, label, color]) => div().text_size(11).text_color(color).child(`${n} ${label}`))))
      .when(this.tab === "checks", (el) => el.child(v_flex().id("pr-checks").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .children(checks.map((c, i) => this.checkRow(c, i, t)))
        .when(!checks.length, (e) => e.child(div().p(8).text_color(t.dim).child("No checks reported")))))
      .when(this.tab === "files", (el) => el.child(this.filesPane(pr, entry, t)));
  }

  candidateRow(c, i, t) {
    const worst = worstCheck(c.pr.statusCheckRollup);
    return v_flex().id(`pr-pick-${c.repo}-${c.pr.number}`).flex_none().px(10).py(7).gap(2).rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
      .opacity(this.revealed ? 1 : 0).transition("opacity", { duration: 220, delay: Math.min(i, 12) * 30, easing: "ease-out" })
      .on_click((_e, cx) => this.choose(c, cx))
      .child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.dim)
        .child(div().flex_none().child(`${c.repo} #${c.pr.number}`))
        .child(div().flex_1().min_w(0).truncate().child(c.branch))
        .when(Boolean(c.local), (el) => el.child(div().flex_none().px(5).rounded(4).bg(t.raised).text_size(10.5).child(c.local))))
      .child(h_flex().gap(8).items_center()
        .child(worst ? this.mark(worst, t) : div().w(14).flex_none())
        .child(div().flex_1().min_w(0).truncate().child(c.pr.title))
        .when(c.pr.isDraft, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("Draft")))
        .child(this.approvalTag(c.pr, t)));
  }

  candidateList(t) {
    const title = this.branch && !this.picked && !this.listing ? `No pull request for ${this.branch} · your open pull requests` : "Your open pull requests";
    return v_flex().id("pr-candidates").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
      .child(div().px(10).py(4).text_size(11.5).text_color(t.dim).child(title))
      .when(!this.candidates, (el) => el.children(this.skeletonCards(6, t)))
      .when(Boolean(this.candidates?.length === 0), (el) => el.child(div().px(10).py(8).text_color(t.dim).child("None open")))
      .when(Boolean(this.candidates?.length), (el) => el.children(this.candidates.map((c, i) => this.candidateRow(c, i, t))));
  }

  skeletonCards(count, t) {
    return Array.from({ length: count }, (_, i) => v_flex().flex_none().px(10).py(7).gap(5)
      .child(h_flex().gap(6).child(this.bone(`sk-c-a-${i}`, 90, 9, t)).child(this.bone(`sk-c-b-${i}`, 120, 9, t)))
      .child(h_flex().gap(8).items_center().child(this.bone(`sk-c-d-${i}`, 12, 12, t)).child(this.bone(`sk-c-e-${i}`, `${50 + ((i * 19) % 40)}%`, 11, t))));
  }

  message(text, color) {
    return div().p(14).text_color(color).whitespace_normal().child(text);
  }

  content(t) {
    if (this.gh === undefined || (!this.scope && !this.error)) return this.skeletonDetail(t);
    if (this.error && !this.candidates && !this.cache.get(this.key)) return this.message(this.error, t.ansi1);
    const entry = this.key ? this.cache.get(this.key) : null;
    if (this.key && !entry) return this.skeletonDetail(t);
    if (entry?.pr) return this.detail(entry.pr, entry, t);
    return this.candidateList(t);
  }

  reveal(cx) {
    const entry = this.key ? this.cache.get(this.key) : null;
    const id = entry?.pr ? this.key : this.candidates ? `list-${this.scope}` : "skeleton";
    if (id === this.revealId) return;
    this.revealId = id; this.revealed = false;
    cx.timer.after(20, (cx) => { this.revealed = true; cx.notify(); });
  }

  render(cx) {
    this.reveal(cx);
    const t = theme(), pr = this.cache.get(this.key)?.pr;
    const where = this.root && this.branch ? `${this.root.split("/").pop()} · ${this.branch}` : "";
    return v_flex().id("pr").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(pr), (el) => el.child(div().id("pr-back").tooltip("All your pull requests").size(24).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.choose(null, cx)).child("←")))
        .child(div().flex_none().font_semibold().child("Pull Request"))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(where))
        .child(div().id("pr-refresh").size(24).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.tick(cx, true)).child("↻"))
        .when(Boolean(props()?.overlay), (el) => el.child(div().id("pr-close").tooltip("Close (Esc)").size(24).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => closeOverlay(props().overlay)).child("✕"))))
      .child(this.progress(t))
      .child(div().id(`pr-content-${this.revealId}`).flex_1().min_h(0).flex().flex_col().opacity(this.busy ? 0.6 : this.revealed ? 1 : 0).transition("opacity", { duration: 200, easing: "ease-out" }).child(this.content(t)))
      .when(Boolean(this.note), (el) => el.child(div().px(12).py(6).text_size(11).text_color(t.ansi1).whitespace_normal().child(this.note)))
      .when(Boolean(pr && pr.state === "OPEN"), (el) => el.child(this.footer(pr, t)));
  }
}
