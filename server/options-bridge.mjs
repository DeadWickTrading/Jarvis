/**
 * Options HQ bridge: the same idea as hq-bridge.mjs (Wick HQ), for Options HQ.
 * Wick HQ is untouched: this lives on its own paths on the same Jarwick server.
 *
 *   GET  /options/...                Options HQ folder, served as-is (open /options/ to talk to Jarwick)
 *   GET  /opt/api/hq/context         compact text snapshot of Options HQ for the model
 *   GET  /opt/api/hq/agent-settings  Voice Agent settings: options role + snapshot + tools
 *   GET  /opt/api/hq/live            levels and the edition's last prices per ticker (no live stock feed yet)
 *   POST /opt/api/hq/idea            append an options idea to Options-HQ/data/jarwick_ideas.csv
 *
 * The page calls these through createHqTools('/opt'), so the tool names stay the
 * same as Wick HQ's (get_live_price, refresh_hq, log_trade_idea) and the voice
 * bundle needs no rebuild. OPTIONS_HQ_DIR overrides the folder.
 * Plain Node, no build step. The only write is the idea log.
 */
import { appendFile, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { jsonBlock } from './hq-bridge.mjs';

const DEFAULT_DIR = join(homedir(), 'Claude', 'Projects', 'DeadWick Labs', 'Options-HQ');
const PAGE = 'Options-HQ.html';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

const clip = (s, n = 220) => {
  const t = String(s ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const v = (x) => (x === null || x === undefined || x === '' ? 'n/a' : x);

/** Trading days from today to an ISO date (weekdays only); null when unknown. Pure. */
export function tradingDaysTo(iso, now = new Date()) {
  if (!iso) return null;
  const end = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(+end)) return null;
  const cur = new Date(now); cur.setHours(12, 0, 0, 0);
  if (end < cur) return -1;
  let n = 0;
  for (const d = new Date(cur); d < end; d.setDate(d.getDate() + 1)) if (d.getDay() % 6) n++;
  return n;
}

/** The snapshot: everything Jarwick may talk about in Options HQ. Pure. */
export function buildOptionsContext(ed, research, journal, now = new Date()) {
  const out = [];
  if (ed) {
    out.push(`OPTIONS HQ EDITION: ${v(ed.edition)} (generated ${v(ed.generatedAt)}; now ${now.toISOString()})`);
    const c = ed.call ?? {};
    out.push(`CALL: ${v(c.stance)} - ${clip(c.headline, 300)} ${clip(c.note, 300)}`);
    const rg = ed.regime ?? {}; const q = rg.qqq ?? {};
    const neg = q.price != null && q.flip != null ? Number(q.price) < Number(q.flip) : null;
    const back = rg.vix != null && rg.vix3m != null ? Number(rg.vix) > Number(rg.vix3m) : null;
    const hits = [neg, back].filter((x) => x === true).length;
    const gate = neg === null && back === null ? 'not set' : ['NORMAL (full size)', 'CAUTION (half size, max loss 500)', 'DEFENSIVE (no new entries)'][hits];
    out.push(`REGIME GATE (rule 11): ${gate}. QQQ ${v(q.price)} vs gamma flip ${v(q.flip)}; VIX ${v(rg.vix)} vs VIX3M ${v(rg.vix3m)}.`);
    const a = ed.account ?? {};
    out.push(`RISK LIMITS: max loss per trade ${v(a.maxRisk)} USD; open risk cap ${v(a.maxOpenRisk)} USD; max ${v(a.maxSameDir ?? 3)} positions in one direction.`);
    for (const w of ed.watchlist ?? []) {
      const g = w.gex ?? {};
      const ed5 = tradingDaysTo(w.earnings, now);
      out.push(
        `TICKER ${w.sym} (${v(w.source)}): price ${v(w.price)}, trend ${v(w.trend)}, put wall ${v(g.putWall)}, flip ${v(g.flip)}, call wall ${v(g.callWall)}, KGS ${v(g.kgs)}, IVR ${v(w.ivr)}, expected move ${v(w.expMove)}, earnings ${v(w.earnings)}${ed5 !== null && ed5 >= 0 ? ` (${ed5} trading days${ed5 <= 5 ? ', INSIDE the no-entry window' : ''})` : ''}, status ${v(w.status)}${w.agents?.view ? `, agents ${clip(w.agents.view, 80)}` : ''}${w.note ? `. ${clip(w.note, 120)}` : ''}`,
      );
    }
    for (const p of ed.plays ?? []) {
      out.push(`PLAY ${p.sym} ${v(p.setup)} ${v(p.dir)}: ${v(p.structure)} ${v(p.legs)} exp ${v(p.expiry)}; trigger ${clip(p.trigger, 100)}; stop ${clip(p.stop, 80)}; target ${clip(p.target, 80)}; max loss per contract ${v(p.maxLossPerContract)}. Why: ${clip(p.why, 200)}`);
    }
    if (!(ed.plays ?? []).length) out.push('PLAYS: none in this edition.');
    const pos = ed.positions ?? [];
    const open = pos.reduce((s, p) => s + (Number(p.maxLoss) || 0), 0);
    out.push(`OPEN POSITIONS: ${pos.length}, open risk ${open} USD.`);
    for (const p of pos) {
      const w = (ed.watchlist ?? []).find((x) => x.sym === p.sym) ?? {};
      const dte = p.expiry ? Math.round((new Date(`${p.expiry}T21:00:00Z`) - now) / 864e5) : null;
      const flags = [];
      if (dte !== null && dte <= 21) flags.push(`${dte} DTE: close or roll now`);
      if (w.earnings && p.expiry && w.earnings <= p.expiry) flags.push(`earnings ${w.earnings} before expiry`);
      if (w.price != null && p.shortStrike != null && p.shortType) {
        const itm = String(p.shortType).toUpperCase() === 'C' ? w.price > p.shortStrike : w.price < p.shortStrike;
        if (itm) flags.push(`short ${p.shortType} ${p.shortStrike} in the money`);
      }
      if (flags.length) out.push(`POSITION CHECK ${p.sym}: ${flags.join('; ')}`);
    }
    for (const p of pos) out.push(`POSITION ${p.sym} ${v(p.dir)} ${v(p.structure)} ${v(p.legs)} exp ${v(p.expiry)} x${v(p.qty)} max loss ${v(p.maxLoss)} P&L ${v(p.pnl)} stop ${clip(p.stop, 60)}`);
    for (const c2 of ed.calendar ?? []) out.push(`NEWS ${c2.date} ${v(c2.time)} ${c2.event} (${c2.impact === 'red' ? 'RED: flat 5 min either side' : 'orange, listed only'})`);
    for (const e of ed.earnings ?? []) out.push(`EARNINGS ${e.sym} ${e.date} ${v(e.when)}`);
  } else {
    out.push('OPTIONS HQ EDITION: not readable.');
  }
  const T = research?.tickers ?? {};
  const names = Object.keys(T).sort();
  if (!names.length) out.push('RESEARCH: no agent runs imported yet (TradingAgents and the hedge-fund panel have not run on Claude yet).');
  for (const t of names) {
    const x = T[t]; const c = x.consensus ?? {}; const ta = x.ta?.[0]; const o = ta?.options ?? {};
    out.push(`RESEARCH ${t}: TradingAgents ${v(c.ta)} (${v(c.taDate)}); panel ${v(c.hfVotes)} avg ${v(c.hfAvg)} (${v(c.hfDate)}); agents ${v(c.agree)}; options analyst ${v(o.verdict)} ${v(o.structure)} ${v(o.legs)}${o.downgraded ? ` (${o.downgraded})` : ''}. ${clip(o.why, 200)}`);
    if (ta?.decision) out.push(`  PM ${t}: ${clip(ta.decision, 400)}`);
  }
  if (journal) {
    const trades = [...(journal.trades ?? [])].sort((p, q) => String(p.date).localeCompare(String(q.date)));
    const net = trades.reduce((s, t) => s + (Number(t.net) || 0), 0);
    out.push(`OPTIONS JOURNAL: ${trades.length} closed trades, net ${net.toFixed(2)} USD.`);
    for (const t of trades.slice(-30)) {
      out.push(`T ${t.date} ${t.inst} ${t.side} ${clip(t.structure, 30)} ${clip(t.legs, 30)} x${v(t.qty)} net ${t.net} R ${v(t.r)} setup ${v(t.family)} agents ${v(t.agents)}${t.rulesText ? ` rules broken:${clip(t.rulesText, 30)}` : ''}`);
    }
  }
  return out.join('\n');
}

const ROLE = "You are Jarwick, Henrik's personal trading assistant, speaking by voice. Right now you are in OPTIONS HQ: Henrik swing-trades options on single US stocks (AAPL, NVDA, MSFT, GOOGL, AMZN, META, TSLA, SPCX) at Interactive Brokers, 30 to 60 days to expiry, using gamma levels from TradeGEX plus two agent panels (TradingAgents and an AI hedge-fund panel).";

const RULES = [
  '',
  '#Options HQ rules (Henrik\'s hard rules; remind him briefly and calmly when an idea breaks one)',
  '1 Max loss per trade 1,000 dollars, defined risk only; contracts = 1,000 divided by max loss per contract, rounded down.',
  '2 Open risk at most 5,000 dollars; at most 3 positions in the same direction (the names move together).',
  '3 Entry only at a mapped level (put wall, call wall, gamma flip, KGS) with the trend or the agents agreeing.',
  '4 IV Rank picks the structure: under 30 buy (long option or debit spread), 30 to 50 debit spread, over 50 credit spread beyond the wall.',
  '5 Open at 30 to 60 days to expiry, out at 21. 6 No new entry within 5 trading days of earnings.',
  '7 Exits set at entry: a daily close beyond the level; debit spreads take half off at plus 100 percent; credit spreads close at 50 percent.',
  '8 Only red news counts: no entries or adjustments 5 minutes either side. 9 No averaging down. 10 Close short legs in the money before expiry and ex-dividend.',
  '11 Regime gate: QQQ below its gamma flip or VIX above VIX3M means half size; both means no new entries. When he asks how things look, mention any POSITION CHECK lines first.',
  '',
  '#Options HQ snapshot and tools',
  'Below is a snapshot of Options HQ (edition, watchlist levels, IV Rank, earnings, plays, positions, agent research, journal) taken when the call started.',
  'Answer briefly; quote levels exactly. If the edition is old or a value is n/a, say so. Say option legs like a trader: "the two-fifty, two-sixty call spread".',
  'There is NO live stock price feed yet: get_live_price returns the levels and the edition\'s last prices, with their time. Never present them as live.',
  'Call refresh_hq before answering about plays, research or positions if the call has run a few minutes.',
  'Trade ideas: check the idea against the rules, the levels, earnings and the agents; give your view in two or three sentences, then call log_trade_idea once. Never give buy or sell instructions; discuss his plan and rules.',
  'Never invent prices, levels, premiums or results.',
  '',
];

export const OPT_FUNCTIONS = [
  { name: 'get_live_price', description: 'Levels and the last edition prices for every watchlist ticker, with distance to the walls and flip. Not live: there is no stock price feed yet.', parameters: { type: 'object', properties: {} } },
  { name: 'refresh_hq', description: 'Re-read Options HQ now (edition, research, journal).', parameters: { type: 'object', properties: {} } },
  {
    name: 'log_trade_idea',
    description: 'Save an options trade idea Henrik discussed, with your view and any rule flags.',
    parameters: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'e.g. NVDA' },
        side: { type: 'string', description: 'bull, bear or neutral' },
        structure: { type: 'string', description: 'e.g. call debit spread 190/200, 45 DTE' },
        level: { type: 'string', description: 'The level it trades from, e.g. put wall 180' },
        idea: { type: 'string', description: "The idea in one sentence, in Henrik's words" },
        view: { type: 'string', description: 'Your view in one or two sentences' },
        flags: { type: 'string', description: 'Rule flags, e.g. earnings in 3 days, no mapped level; empty if none' },
      },
      required: ['idea', 'view'],
    },
  },
];

/** Levels report per ticker. Pure. */
export function levelsReport(ed, now = new Date()) {
  if (!ed) return 'Options HQ edition not readable.';
  const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const age = ed.generatedAt ? Math.round((now - new Date(ed.generatedAt)) / 3.6e6) : null;
  const out = [`No live stock feed yet. Prices below are from the edition "${v(ed.edition)}"${age !== null ? `, ${age} hours old` : ''}.`];
  for (const w of ed.watchlist ?? []) {
    const g = w.gex ?? {};
    if (w.price === null || w.price === undefined) { out.push(`${w.sym}: no price or levels in the edition yet.`); continue; }
    const d = (lvl, name) => (lvl === null || lvl === undefined ? null : `${name} ${fmt(lvl)} (${w.price >= lvl ? `${fmt(w.price - lvl)} above` : `${fmt(lvl - w.price)} below`})`);
    out.push(`${w.sym} ${fmt(w.price)}: ${[d(g.putWall, 'put wall'), d(g.flip, 'flip'), d(g.callWall, 'call wall'), d(g.kgs, 'KGS')].filter(Boolean).join(', ') || 'no levels'}; IVR ${v(w.ivr)}.`);
  }
  return out.join('\n');
}

const csvCell = (x) => `"${String(x ?? '').replace(/"/g, '""').replace(/[\r\n]+/g, ' ').slice(0, 500)}"`;
export const OPT_IDEA_HEADER = 'time,ticker,side,structure,level,idea,jarwick_view,rule_flags,edition_price';

/** Settings for Options HQ: options role + keyterms + rules + snapshot + tools. Pure. */
export function optionsSettings(settings, context) {
  const copy = structuredClone(settings);
  const agent = copy?.agent ?? {};
  const think = agent.think;
  if (think) {
    let base = String(think.prompt ?? '');
    base = base.replace(/You are Jarwick[^\n]*/, ROLE);
    base = base.replace(/You have no live market data or access to Henrik's files yet\.[^.]*\.[^.]*\.\s*/, '');
    think.prompt = `${base}\n${RULES.join('\n')}\n${context}`;
    const have = new Set((think.functions ?? []).map((f) => f.name));
    think.functions = [...(think.functions ?? []).filter((f) => !OPT_FUNCTIONS.some((o) => o.name === f.name)), ...OPT_FUNCTIONS];
    void have;
  }
  const kt = agent.listen?.provider?.keyterms;
  if (Array.isArray(kt)) {
    const extra = ['AAPL', 'NVDA', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA', 'SPCX', 'IV rank', 'debit spread', 'credit spread', 'DTE', 'TradingAgents', 'hedge fund panel', 'options HQ'];
    agent.listen.provider.keyterms = [...new Set([...kt, ...extra])].slice(0, 50);
  }
  if (agent.greeting) agent.greeting = 'Good day, sir. Jarwick in Options HQ. What do you need?';
  return copy;
}

export function createOptionsBridge({ dir = process.env.OPTIONS_HQ_DIR || DEFAULT_DIR, settings } = {}) {
  const root = resolve(dir);
  const page = join(root, PAGE);
  const ideaLog = join(root, 'data', 'jarwick_ideas.csv');

  const blocks = async () => {
    const html = await readFile(page, 'utf8');
    return { ed: jsonBlock(html, 'opt-bias'), research: jsonBlock(html, 'opt-research'), journal: jsonBlock(html, 'dl-opt-journal') };
  };
  const snapshot = async () => { const b = await blocks(); return buildOptionsContext(b.ed, b.research, b.journal); };

  const readBody = (req) => new Promise((ok, fail) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 20_000) fail(new Error('body too large')); });
    req.on('end', () => ok(data));
    req.on('error', fail);
  });

  const logIdea = async (body) => {
    const i = JSON.parse(body || '{}');
    const { ed } = await blocks();
    const w = (ed?.watchlist ?? []).find((x) => x.sym === String(i.ticker ?? '').toUpperCase());
    let exists = true;
    try { await stat(ideaLog); } catch { exists = false; }
    const row = [new Date().toISOString(), i.ticker, i.side, i.structure, i.level, i.idea, i.view, i.flags, w?.price ?? ''].map(csvCell).join(',');
    await appendFile(ideaLog, `${exists ? '' : `${OPT_IDEA_HEADER}\n`}${row}\n`, 'utf8');
    return 'Saved to the Options HQ idea log.';
  };

  return async function handleOptions(req, res, next) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = decodeURIComponent(url.pathname);
    try {
      if (path === '/options' || path === '/options/') {
        res.statusCode = 302; res.setHeader('Location', `/options/${PAGE}`); res.end(); return;
      }
      if (path.startsWith('/options/')) {
        const file = normalize(join(root, path.slice(9)));
        if (file !== root && !file.startsWith(root + sep)) { res.statusCode = 403; res.end('Forbidden'); return; }
        const body = await readFile(file);
        res.setHeader('Content-Type', TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.end(body); return;
      }
      if (path === '/opt/api/hq/context') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
        res.end(await snapshot()); return;
      }
      if (path === '/opt/api/hq/live') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
        res.end(levelsReport((await blocks()).ed)); return;
      }
      if (path === '/opt/api/hq/idea' && req.method === 'POST') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(await logIdea(await readBody(req))); return;
      }
      if (path === '/opt/api/hq/agent-settings') {
        if (!settings) throw new Error('no agent settings were given to the Options HQ bridge');
        res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(optionsSettings(settings, await snapshot()))); return;
      }
    } catch (error) {
      res.statusCode = error?.code === 'ENOENT' ? 404 : 500;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(`Options HQ bridge: ${error?.message ?? error}`);
      return;
    }
    if (next) next();
    else { res.statusCode = 404; res.end('Not found'); }
  };
}

/** Vite plugin wrapper, used by apps/demo/vite.config.ts. */
export function optionsBridgePlugin(options = {}) {
  const handler = createOptionsBridge(options);
  const install = (server) => { server.middlewares.use(handler); };
  return { name: 'jarwick-options-bridge', configureServer: install, configurePreviewServer: install };
}
