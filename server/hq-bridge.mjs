/**
 * HQ bridge: lets Jarwick see Henrik's HQ and lets HQ talk to Jarwick.
 *
 *   GET /hq/...                 the HQ folder, served as-is (so the page is on
 *                               http://127.0.0.1, where the microphone and the
 *                               agent relay are allowed)
 *   GET /api/hq/context         a compact text snapshot of HQ for the model
 *   GET /api/hq/agent-settings  the Voice Agent settings with that snapshot
 *                               appended to the prompt
 *
 * Plain Node, no build step. Read-only: nothing here writes to the HQ folder.
 * HQ_DIR overrides the folder; the default is Henrik's NQ-Cockpit.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';

const DEFAULT_HQ_DIR = join(homedir(), 'Claude', 'Projects', 'DeadWick Labs', 'NQ-Cockpit');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

/** Pull a JSON <script type="application/json" id="..."> block out of the page. */
export function jsonBlock(html, id) {
  const m = html.match(new RegExp(`<script[^>]*id="${id}"[^>]*>([\\s\\S]*?)</script>`));
  if (!m) return null;
  try {
    return JSON.parse(m[1].replace(/<\\\//g, '</'));
  } catch {
    return null;
  }
}

const clip = (s, n = 220) => {
  const t = String(s ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The snapshot: everything Jarwick may talk about, nothing it may not. Pure. */
export function buildContext(bias, journal, now = new Date()) {
  const out = [];
  if (bias) {
    out.push(`HQ EDITION: ${bias.edition ?? '?'} (generated ${bias.generatedAt ?? '?'}; now ${now.toISOString()})`);
    const b = bias.bias ?? {};
    out.push(`BIAS: ${b.label ?? '?'} ${b.score ?? ''} (confidence ${b.confidence ?? '?'}). ${clip(b.headline, 400)}`);
    if (b.oneLiner) out.push(`CONTEXT: ${clip(b.oneLiner, 600)}`);
    const p = bias.plays ?? {};
    if (p.asOf) out.push(`PLAYS as of ${p.asOf}. ${clip(p.note, 300)}`);
    for (const d of p.dayType ?? []) out.push(`- ${d.k}: ${d.v} - ${clip(d.d, 200)}`);
    for (const r of p.rows ?? []) {
      out.push(
        `PLAY ${r.id} (${r.side}, ${r.stars} stars) zone ${r.zone}. Why: ${clip(r.why, 260)} Trigger: ${clip(r.trigger, 160)} Stop: ${clip(r.stop, 80)}. T1 ${r.t1}, T2 ${r.t2}. ES: ${clip(r.es, 120)}. Size: ${clip(r.size, 80)}`,
      );
    }
    for (const r of p.esRows ?? []) out.push(`ES PLAY ${r.id} (${r.side}) ${r.zone}: ${clip(r.trigger, 120)} T1 ${r.t1}, T2 ${r.t2}`);
    const lv = bias.levels?.rows ?? [];
    if (lv.length) out.push(`LEVELS: ${lv.map((l) => `${l.price} ${clip(l.tag, 70)}`).join(' | ')}`);
    const sc = bias.scenarios ?? {};
    for (const k of ['bull', 'base', 'bear']) if (sc[k]) out.push(`SCENARIO ${k}: ${clip(sc[k].trigger, 140)} -> ${clip(sc[k].path, 140)} (invalid: ${clip(sc[k].invalidation, 80)})`);
    for (const c of bias.calendar ?? []) out.push(`NEWS ${c.date} ${c.time} ${c.event} (${c.imp === 'h' ? 'red' : c.imp === 'm' ? 'orange' : 'low'})`);
    const es = bias.es?.live;
    if (es) out.push(`ES: ${clip(es.esCondition, 200)} ${clip(es.divergence, 120)}`);
    for (const m of bias.macro ?? []) out.push(`MACRO ${m.k}: ${m.v} - ${clip(m.d, 120)}`);
    const tr = bias.trackRecord?.summary;
    if (tr) out.push(`BIAS TRACK RECORD: ${tr.scored} scored, ${tr.correct} correct, ${tr.wrong} wrong.`);
  } else {
    out.push('HQ EDITION: not readable.');
  }
  if (journal) {
    const a = journal.account ?? {};
    // Privacy: no account name / ID and no balance leave the Mac - only the rules and P&L.
    out.push(`ACCOUNT RULES: 50K evaluation; target +${a.target && a.start ? a.target - a.start : '?'} USD; day stop ${a.dayStop ?? '?'}; max risk per trade ${a.maxRisk ?? '?'}.`);
    const trades = [...(journal.trades ?? [])].sort((x, y) => `${x.date}${x.timeIn}`.localeCompare(`${y.date}${y.timeIn}`));
    const byDay = new Map();
    for (const t of trades) byDay.set(t.date, (byDay.get(t.date) ?? 0) + (Number(t.net) || 0));
    const days = [...byDay.entries()].slice(-10);
    if (days.length) out.push(`DAILY NET (last ${days.length}): ${days.map(([d, n]) => `${d} ${n.toFixed(2)}`).join(', ')}`);
    const wins = trades.filter((t) => Number(t.net) > 10).length;
    const losses = trades.filter((t) => Number(t.net) < -10).length;
    out.push(`ALL LOGGED TRADES: ${trades.length}, winners ${wins}, losers ${losses}, net ${trades.reduce((s, t) => s + (Number(t.net) || 0), 0).toFixed(2)} USD.`);
    for (const t of trades.slice(-15)) {
      out.push(
        `TRADE ${t.date} ${t.timeIn} ${t.side} ${t.contracts ?? ''} net ${t.net} grade ${t.grade ?? '?'} - ${clip(t.setup, 90)}; ${clip(t.plan ?? t.planLink, 70)}; ${clip(t.notes, 140)}`,
      );
    }
  }
  return out.join('\n');
}

const RULES = [
  '',
  '#HQ snapshot',
  'Below is a read-only snapshot of Henrik\'s HQ page (his morning edition, plays, levels, news and trading journal).',
  'Answer questions about it directly and briefly. Quote levels exactly as written. If the edition is from an earlier day, say so before using it.',
  'If something is not in the snapshot, say you do not have it. Never invent prices, levels or results. You have no live price feed.',
  '',
];

/** Settings with the snapshot appended to the agent prompt. Pure. */
export function settingsWithContext(settings, context) {
  const copy = structuredClone(settings);
  const think = copy?.agent?.think;
  if (think) {
    const base = String(think.prompt ?? '').replace(/You have no live market data or access to Henrik's files yet\.[^.]*\.[^.]*\.\s*/, '');
    think.prompt = `${base}\n${RULES.join('\n')}\n${context}`;
  }
  return copy;
}

export function createHqBridge({ hqDir = process.env.HQ_DIR || DEFAULT_HQ_DIR, settings } = {}) {
  const root = resolve(hqDir);
  const page = join(root, 'NQ-Cockpit.html');

  const snapshot = async () => {
    const html = await readFile(page, 'utf8');
    return buildContext(jsonBlock(html, 'nq-bias'), jsonBlock(html, 'dl-journal'));
  };

  return async function handleHq(req, res, next) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = decodeURIComponent(url.pathname);
    try {
      if (path === '/hq' || path === '/hq/') {
        res.statusCode = 302;
        res.setHeader('Location', '/hq/NQ-Cockpit.html');
        res.end();
        return;
      }
      if (path.startsWith('/hq/')) {
        const file = normalize(join(root, path.slice(4)));
        if (file !== root && !file.startsWith(root + sep)) {
          res.statusCode = 403;
          res.end('Forbidden');
          return;
        }
        const body = await readFile(file);
        res.setHeader('Content-Type', TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.end(body);
        return;
      }
      if (path === '/api/hq/context') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(await snapshot());
        return;
      }
      if (path === '/api/hq/agent-settings') {
        if (!settings) throw new Error('no agent settings were given to the HQ bridge');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(settingsWithContext(settings, await snapshot())));
        return;
      }
    } catch (error) {
      res.statusCode = error?.code === 'ENOENT' ? 404 : 500;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(`HQ bridge: ${error?.message ?? error}`);
      return;
    }
    if (next) next();
    else {
      res.statusCode = 404;
      res.end('Not found');
    }
  };
}

/** Vite plugin wrapper, used by apps/demo/vite.config.ts. */
export function hqBridgePlugin(options = {}) {
  const handler = createHqBridge(options);
  const install = (server) => server.middlewares.use(handler);
  return { name: 'jarwick-hq-bridge', configureServer: install, configurePreviewServer: install };
}
