/**
 * HQ bridge: lets Jarwick see Henrik's HQ and lets HQ talk to Jarwick.
 *
 *   GET /hq/...                 the HQ folder, served as-is (so the page is on
 *                               http://127.0.0.1, where the microphone and the
 *                               agent relay are allowed)
 *   GET /api/hq/context         a compact text snapshot of HQ for the model
 *   GET /api/hq/playbook        PLAYBOOK.md, Henrik's strategy document (the method;
 *                               the snapshot is the day). ?topic=... returns the
 *                               matching section(s) - what the read_playbook tool calls
 *   GET /api/hq/agent-settings  the Voice Agent settings with that snapshot
 *                               and the playbook digest appended to the prompt,
 *                               plus Jarwick's tools. Deepgram caps the prompt at
 *                               25,000 chars with a managed LLM, so only the digest
 *                               goes in and the journal is trimmed to fit
 *   GET /api/hq/fill?play=...   today's Wick-entry fills at a play, told in points (review_fill)
 *   GET /api/hq/live            last price from ATAS (DL Sweep Meter writes
 *                               journal/live_NQ.json, live_ES.json) and the
 *                               distance to every play
 *   POST /api/hq/idea           append a trade idea Henrik discussed with
 *                               Jarwick to NQ-Cockpit/data/jarwick_ideas.csv
 *
 * Plain Node, no build step. The only write is the idea log.
 * HQ_DIR overrides the folder; the default is Henrik's NQ-Cockpit.
 * PLAYBOOK overrides the playbook file; the default is <HQ_DIR>/PLAYBOOK.md.
 * PROMPT_CAP overrides the prompt budget (default 24500 chars).
 */
import { appendFile, readFile, stat } from 'node:fs/promises';
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
  '.md': 'text/markdown; charset=utf-8',
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


/** "30,013 (KGS 725)" -> 30013; null when no price. Pure. */
const firstPrice = (s) => {
  const m = String(s ?? '').replace(/(\d),(\d{3})/g, '$1$2').match(/\d{4,6}(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};
const pts = (n, unit = true) => {
  const v = Math.abs(Number(n));
  const t = v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
  return unit ? `${t} ${t === '1' ? 'pt' : 'pts'}` : t;
};
const signed = (n) => `${Number(n) >= 0 ? '+' : '-'}${pts(n)}`;

/**
 * One fill of the Wick entry told as a sentence in points, not prices - what Jarwick
 * says when Henrik asks "what would long 2 have done?". Pure.
 * e = one entry of the dl-wick-entries JSON; play = the matching play row of the edition (optional).
 */
export function wickStory(e, play) {
  const parts = [];
  const lvl = String(e.level ?? '').replace(/\.0+$/, '');
  const head = `WICK ${e.time} ${e.play} at ${Number(lvl).toLocaleString('en-US')}${e.attempt > 1 ? ` (attempt ${e.attempt})` : ''}`;
  // the sweep
  if (e.depth != null) parts.push(e.depth > 20 ? `swept ${pts(e.depth)} past the level - deeper than 20, that is acceptance, not a trap` : `swept ${pts(e.depth)} past the level${e.depth <= 3 ? ' (a shallow poke)' : e.depth >= 12 ? ' (a deep sweep)' : ''}`);
  if (e.volBeyond != null) parts.push(`${pts(e.volBeyond, false)} % of the sweep candle's volume traded beyond${e.volBeyond > 50 ? ' - amber chip' : ''}`);
  // was it a valid wick entry, and what did the tool do
  const what = {
    taken: 'wick entry valid, live order taken',
    ticket: 'wick entry valid, paper ticket only',
    skip: `wick entry fired but skipped: ${e.detail}`,
    spent: `wick entry fired but the level was spent: ${e.detail}`,
    fired: e.statusText === 'armed' ? 'wick entry valid, armed but no fill was sent' : 'wick entry valid, tool not armed so no order',
  }[e.status] ?? `wick entry ${e.statusText}`;
  parts.push(what);
  if (e.risk) parts.push(`stop ${pts(e.risk)}${Number(e.risk) <= 7 ? ' (min)' : ''}`);
  // how far the plan's targets were from the entry, when this fill belongs to the current play row
  if (play && e.entry) {
    const t1 = firstPrice(play.t1), t2 = firstPrice(play.t2), en = Number(e.entry);
    const dir = e.side === 'short' ? -1 : 1;
    const d1 = t1 ? (t1 - en) * dir : null, d2 = t2 ? (t2 - en) * dir : null;
    if (d1 && d1 > 0) parts.push(`T1 ${pts(d1)} away${d2 && d2 > 0 ? `, T2 ${pts(d2)}` : ''}`);
  }
  // what happened
  if (e.status === 'taken' || e.status === 'ticket') {
    if (e.outcome) parts.push(`outcome: ${String(e.outcome).replace(/ ticket/i, '')}`);
    if (e.result != null && e.r != null) parts.push(`tracked ${signed(e.result)} (${Number(e.r).toFixed(1)}R)`);
  }
  if (e.mfe != null || e.mae != null) parts.push(`went ${pts(e.mfe ?? 0)} in favour, ${pts(e.mae ?? 0, false)} against`);
  const sh = e.shadow;
  if (sh && sh.how) {
    const how = { stop: 'stopped out', be: 'scratched at break-even', 'be after p1': 'first part paid, runner scratched at break-even', runner: 'ran to the runner target', flat: 'flattened at the time limit' }[sh.how] ?? sh.how;
    parts.push(`forward test: ${how}${sh.pts != null ? `, ${signed(sh.pts)}${sh.r != null ? ` (${Number(sh.r).toFixed(1)}R)` : ''}` : ''}${sh.mfe ? `, went ${pts(sh.mfe)} in favour first` : ''}`);
  } else if (e.status !== 'taken' || e.result == null) {
    parts.push('forward test: not decided yet');
  }
  return `${head}: ${parts.join('; ')}.`;
}

/** The Wick-entries block of the snapshot: tally + one story per fill. Pure. */
export function wickSection(wick, bias) {
  if (!wick) return [];
  const out = [];
  const rows = [...(bias?.plays?.rows ?? []), ...(bias?.plays?.esRows ?? [])];
  const playFor = (e) => rows.find((r) => r.id === e.play && zoneRange(r.zone)?.[0] - 5 <= Number(e.level) && Number(e.level) <= zoneRange(r.zone)?.[1] + 5);
  const all = [...(wick.nq ?? []), ...(wick.es ?? [])];
  const n = (st) => all.filter((e) => e.status === st).length;
  const tracked = all.filter((e) => e.result != null);
  const sh = all.filter((e) => e.shadow?.pts != null);
  const sum = (list, k) => list.reduce((s, e) => s + Number(k(e) || 0), 0);
  out.push(
    `WICK ENTRIES ${wick.date} (updated ${wick.updated}; fill = the sweep-and-reclaim trigger fired at a play; not armed = tool off, no order): ${all.length} fills - ${n('taken')} taken live, ${n('ticket')} paper tickets, ${n('skip')} skipped, ${n('spent')} spent, ${n('fired')} not armed. Tracked trades: ${tracked.filter((e) => e.result > 0).length}W ${tracked.filter((e) => e.result < 0).length}L ${signed(sum(tracked, (e) => e.result))}. Forward test (every fill run with the ticket plan): ${sh.filter((e) => e.shadow.pts > 0).length}W ${sh.filter((e) => e.shadow.pts < 0).length}L ${signed(sum(sh, (e) => e.shadow.pts))}${sh.length < all.length ? `, ${all.length - sh.length} not decided yet` : ''}.`,
  );
  for (const e of all) out.push(wickStory(e, playFor(e)));
  return out;
}

/** The snapshot: everything Jarwick may talk about, nothing it may not. Pure. */
export function buildContext(bias, journal, now = new Date(), wick = null) {
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
  out.push(...wickSection(wick, bias));
  if (journal) {
    const a = journal.account ?? {};
    // Privacy: no account name / ID and no balance leave the Mac - only the rules and P&L.
    out.push(`ACCOUNT RULES: 50K evaluation; target +${a.target && a.start ? a.target - a.start : '?'} USD; day stop ${a.dayStop ?? '?'}; max risk per trade ${a.maxRisk ?? '?'}.`);
    const trades = [...(journal.trades ?? [])].sort((x, y) => `${x.date}${x.timeIn}`.localeCompare(`${y.date}${y.timeIn}`));
    const net = (list) => list.reduce((s, t) => s + (Number(t.net) || 0), 0).toFixed(2);
    // Per account: trade count and P&L only (no balances or IDs, see privacy note above).
    for (const acc of journal.accounts ?? []) {
      const list = trades.filter((t) => t.account === acc.id);
      if (!list.length) continue;
      const span = `${acc.from ?? list[0].date} to ${acc.to ?? 'now'}`;
      out.push(`ACCOUNT ${clip(acc.label, 40)} (${span}): ${list.length} trades, net ${net(list)} USD.`);
    }
    const byDay = new Map();
    for (const t of trades) byDay.set(t.date, (byDay.get(t.date) ?? 0) + (Number(t.net) || 0));
    if (byDay.size) out.push(`DAILY NET (every logged day): ${[...byDay.entries()].map(([d, n]) => `${d} ${n.toFixed(2)}`).join(', ')}`);
    out.push('A weekday missing from DAILY NET means no strategy trades were logged that day. 7 Oct 2026 (the evaluation breach day) is left out of the journal on purpose.');
    const wins = trades.filter((t) => Number(t.net) > 10).length;
    const losses = trades.filter((t) => Number(t.net) < -10).length;
    out.push(`ALL LOGGED TRADES: ${trades.length}, winners ${wins}, losers ${losses}, scratches ${trades.length - wins - losses}, net ${net(trades)} USD.`);
    // Every trade in one short line, so questions about any day can be answered.
    for (const t of trades) {
      out.push(`T ${t.date} ${t.timeIn} ${t.side} ${t.qty ?? ''} net ${t.net} ${t.grade ?? '?'} ${clip(t.play || (t.offPlan ? 'off-plan' : ''), 24)}${t.rulesText && !/^none$/i.test(String(t.rulesText).trim()) ? ` rules:${clip(t.rulesText, 40)}` : ''}`);
    }
    // The most recent trades with setup and notes.
    for (const t of trades.slice(-15)) {
      out.push(
        `TRADE DETAIL ${t.date} ${t.timeIn} ${t.side} ${t.qty ?? ''} net ${t.net} grade ${t.grade ?? '?'} - ${clip(t.setup, 90)}; ${clip(t.plan ?? t.planLink, 70)}; ${clip(t.notes, 140)}`,
      );
    }
  }
  return out.join('\n');
}

const RULES = [
  '',
  '#HQ snapshot and tools',
  'Below is a snapshot of Henrik\'s HQ page (his morning edition, plays, levels, news and trading journal) taken when the call started. The playbook above is the method; this snapshot is today\'s map.',
  'Answer questions about it directly and briefly. Quote levels exactly as written. If the edition is from an earlier day, say so before using it.',
  'Tools: call get_live_price whenever price, distance to a play or "where are we" matters - never guess a price. Call refresh_hq before answering about plays or the plan if the call has run more than a few minutes, because Henrik updates HQ during the session. Call review_fill when he asks how a play or fill went, what it would have done, or whether the entry was valid - it is fresher than the WICK lines below.',
  'Trade ideas: when Henrik describes a trade idea, check it against the plays, his rules (attempts per level, red news, size and risk limits, the flip, the sweep, volume beyond) and the live price, give your view in two or three sentences, then call log_trade_idea once with a short summary. Do not call it for casual questions.',
  'If something is in neither the playbook, the snapshot nor the tools, say you do not have it. Never invent prices, levels or results.',
  '',
  '#How to speak',
  'Talk like a mentor at the desk, not a terminal. Speak in points and level names ("the ON low", "Long 2", "the 0.618", "T1"), never in prices, unless Henrik asks where a level is or what the price is. Round points to whole numbers ("about 12 points"). When you do say a price, say it the trader way: 30,050 is "thirty oh fifty", 29,722 is "twenty-nine seven twenty-two" - never "thirty thousand and fifty".',
  'Reviewing a play or a fill (the WICK lines): lead with the verdict in one short sentence (worked, failed, not a valid entry, undecided), then the four beats in order - how far it swept, was the wick entry valid and what the tool did, how big the stop was, how many points it made or lost and the R. Then stop and offer the detail: "want the numbers?". Two to four spoken sentences in all.',
  'A level the plays no longer carry (the edition was updated) is still a real fill - say it was an earlier play at that level. "Not decided yet" means the forward test is still running; say so rather than guessing.',
  '',
];

const PLAYBOOK_RULES = [
  '',
  '#Playbook',
  'Below is the digest of Henrik\'s trading playbook (NQ-Cockpit/PLAYBOOK.md): the strategy, every level type, sweeps, trend lines, the opening range, the entry triggers, his six rules and setups, the indicators and what his data says. The full document is thirteen sections; call read_playbook with the section number or a topic whenever he asks what something is, why a rule exists, how a setup works, or for numbers - the digest is the summary, the tool has the detail. Answer in his own vocabulary. Where the playbook says "on test" or "log only", say so. Keep spoken answers short: lead with the one-sentence answer, add detail only if he asks.',
  '',
];

/** Prompt budget: Deepgram's managed-LLM cap is 25,000 chars; keep a margin. */
export const PROMPT_CAP = Number(process.env.PROMPT_CAP) || 24_500;

/** The digest block of the playbook (between the DIGEST markers), or the first 4,000 chars. Pure. */
export function playbookDigest(playbook) {
  const text = String(playbook ?? '');
  const m = text.match(/<!--\s*DIGEST:START\s*-->([\s\S]*?)<!--\s*DIGEST:END\s*-->/);
  const body = (m ? m[1] : text.slice(0, 4000)).trim();
  return body.replace(/^## 0 · Digest[^\n]*\n/, '').trim();
}

/** Split the playbook into its "## " sections: [{ n, title, text }]. Pure. */
export function playbookSections(playbook) {
  const out = [];
  const parts = String(playbook ?? '').split(/\n(?=## )/);
  for (const part of parts) {
    const m = part.match(/^## (\d+) · ([^\n]*)/);
    if (!m) continue;
    out.push({ n: Number(m[1]), title: m[2].trim(), text: part.trim() });
  }
  return out;
}

const SECTION_HINTS = {
  1: 'strategy rules rule account iq capital clock time madrid session window size rank six rules daily stop news',
  2: 'regime gamma flip hvl call wall put wall kgs strike hedge flow bubbles vanna charm crown hvs split day tradegex menthorq rank source trend-up',
  3: 'level map tier vwap pdh pdl pd50 tdo asia london overnight data candle fvg ifvg ce gap order block quarter point round number value area poc shelf shelves equal highs liquidity',
  4: 'fib fibonacci retracement 0.236 0.786 0.5 equilibrium premium discount extension -0.786 -0.236 anchor overnight on 9am 3c three candle flip cascade dead range golden shallow',
  5: 'sweep trap liquidity depth acceptance volume beyond manipulation candle instant reaction inducement re-sweep rejections approach side killzone smt double fire',
  6: 'trend line trendline structure true trend impulse trend break choch change of character broken glass resistance support role flip head and shoulders stop exit',
  7: 'orb opening range break retest rejection failed break atr candle setup b midline back into orb',
  8: 'trigger entry triggers ifvg displacement break-and-retest 3-bar print retap body close confirmation anticipation setup d grade grading a+',
  9: 'setup a setup b setup c setup d gap return flip version shape shapes gallery look-alike not it textbook two candles grind deep liquidity beyond second attempt long failed break golden reversal expansion london sweep induced equal highs takeover',
  10: 'risk stop stops size sizing target targets tp ladder management break-even be runner trail trailing partial worth discipline psychology',
  11: 'indicator indicators dl levels executioner sweep meter gamma history atr candle risk calc htf fvg killzone order flow volume profile va reversion cockpit brand banner tradegex menthorq wick hq journal studies tools',
  12: 'mentor lesson lessons mistake mistakes companion card last time wait for',
  13: 'glossary what is meaning define definition example answer abbreviation',
};

/** The section(s) of the playbook for a request. topic may be a number ("4"), a title word or a question. Pure. */
export function playbookLookup(playbook, topic, maxChars = 12_000) {
  const sections = playbookSections(playbook);
  if (!sections.length) return 'The playbook is not available.';
  const q = String(topic ?? '').trim().toLowerCase();
  const toc = () => sections.map((x) => `${x.n} · ${x.title}`).join('\n');
  if (!q) return `Playbook sections (call again with a number or a topic):\n${toc()}`;
  const nums = [...new Set((q.match(/\b(1[0-3]|[1-9])\b/g) ?? []).map(Number))].filter((n) => sections.some((x) => x.n === n));
  let picked = nums.length && q.replace(/[\d\s,and]+/g, '').length < 3 ? sections.filter((x) => nums.includes(x.n)) : [];
  if (!picked.length) {
    const words = q.replace(/[^a-z0-9.+\-]+/g, ' ').split(' ').filter((w) => w.length > 2 && !['the', 'what', 'how', 'why', 'and', 'for', 'his', 'does', 'about', 'tell', 'explain', 'level', 'levels', 'trade', 'trading'].includes(w));
    const scored = sections.map((x) => {
      const hay = `${x.title} ${SECTION_HINTS[x.n] ?? ''}`.toLowerCase();
      const body = x.text.toLowerCase();
      let score = 0;
      for (const w of words) {
        if (hay.includes(w)) score += 5;
        const hits = body.split(w).length - 1;
        score += Math.min(hits, 8);
      }
      return { x, score };
    });
    scored.sort((a, b) => b.score - a.score || a.x.n - b.x.n);
    picked = scored.filter((s) => s.score > 0).slice(0, 2).map((s) => s.x);
    if (picked.length === 2 && scored[0].score >= 2 * scored[1].score) picked = [picked[0]];
  }
  if (!picked.length) return `Nothing in the playbook matched "${topic}". Sections:\n${toc()}`;
  let out = picked.map((x) => x.text).join('\n\n');
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 60)}\n…(section cut at ${maxChars} chars; ask for a narrower topic)`;
  return out;
}

/** Drop the oldest journal lines from the snapshot until the whole prompt fits the cap. Pure. */
export function fitContext(context, room) {
  if (context.length <= room) return context;
  const lines = context.split('\n');
  const drop = (prefix) => {
    for (let i = 0; i < lines.length && lines.join('\n').length > room; i++) {
      if (lines[i].startsWith(prefix)) lines.splice(i--, 1);
    }
  };
  // Oldest one-line trades first (the last 25 stay), then the recent detail, then the rest.
  const keepT = lines.filter((l) => l.startsWith('T ')).slice(-25);
  for (let i = 0; i < lines.length && lines.join('\n').length > room; i++) {
    if (lines[i].startsWith('T ') && !keepT.includes(lines[i])) lines.splice(i--, 1);
  }
  drop('TRADE DETAIL ');
  drop('T ');
  let out = lines.join('\n');
  if (out.length !== context.length) out += '\n(Older trade lines were left out to fit the prompt - call refresh_hq for the full journal.)';
  if (out.length > room) out = out.slice(0, Math.max(0, room - 80)) + '\n(snapshot cut to fit the prompt - call refresh_hq for the rest)';
  return out;
}

/** Jarwick's client-side tools (answered by HQ through the bridge). */
export const HQ_FUNCTIONS = [
  {
    name: 'read_playbook',
    description: 'Read a section of Henrik\'s trading playbook (the method: levels, fibs, sweeps, ORB, setups, rules, indicators, data). Call it whenever he asks what something is, how a setup works, why a rule exists, or for the numbers behind it. Pass a section number (1-13) or a topic such as "0.236", "ORB break and retest", "setup C", "VWAP", "trend break".',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Section number 1-13, or a topic / question in a few words. Empty = the list of sections.' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'review_fill',
    description: 'The story of today\'s Wick-entry fills at one play, fresh from HQ, in points: how far it swept, whether the wick entry was valid and what the tool did, the stop, the result and R, and the forward test. Call it when Henrik asks what a play would have done, how a fill went, or whether an entry was valid. Pass the play name ("Long 2", "Short 1", "ES Short 2") or "all".',
    parameters: {
      type: 'object',
      properties: {
        play: { type: 'string', description: 'Play name such as "Long 2" or "Short 1" (case does not matter), or "all" for every fill today.' },
      },
      required: ['play'],
    },
  },
  {
    name: 'get_live_price',
    description: 'Last NQ and ES price from ATAS and the distance in points to every play zone. Use whenever price or distance matters.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'refresh_hq',
    description: 'Re-read HQ now (plays, levels, news, journal) - plans change during the session.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'log_trade_idea',
    description: 'Save a trade idea Henrik discussed, with your view, so it can be reviewed later.',
    parameters: {
      type: 'object',
      properties: {
        instrument: { type: 'string', description: 'NQ, MNQ, ES or MES' },
        side: { type: 'string', description: 'long or short' },
        level: { type: 'string', description: 'Price or zone, e.g. 31,300 or Short 1' },
        idea: { type: 'string', description: 'The idea in one sentence, in Henrik\'s words' },
        view: { type: 'string', description: 'Your view in one or two sentences' },
        flags: { type: 'string', description: 'Rule flags, e.g. third attempt, red news in 4 min, not a plan level; empty if none' },
      },
      required: ['idea', 'view'],
    },
  },
];

/** The stories of the fills at one play (or all), for the review_fill tool. Pure. */
export function fillReport(wick, bias, play) {
  if (!wick) return 'No Wick-entry fills are recorded for today.';
  const lines = wickSection(wick, bias);
  const q = String(play ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!q || q === 'all') return lines.join('\n');
  const want = lines.filter((l, i) => i > 0 && l.toLowerCase().includes(` ${q} at `));
  if (!want.length) {
    const names = [...new Set([...(wick.nq ?? []), ...(wick.es ?? [])].map((e) => e.play))];
    return `No fill at ${play} today. Fills today: ${names.join(', ') || 'none'}.`;
  }
  return `${lines[0]}\n${want.join('\n')}`;
}

/** "31,228-31,300" or "30,975" -> [low, high]; null when no number. Pure. */
export function zoneRange(zone) {
  const nums = String(zone ?? '').replace(/(\d),(\d{3})/g, '$1$2').match(/\d+(?:\.\d+)?/g);
  if (!nums) return null;
  const v = nums.map(Number).filter((n) => n > 1000);
  if (!v.length) return null;
  return [Math.min(...v), Math.max(...v)];
}

/** Text report of live prices and distances to plays. Pure. */
export function liveReport(bias, live, now = new Date()) {
  const out = [];
  const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  for (const [fam, rows] of [['NQ', bias?.plays?.rows ?? []], ['ES', bias?.plays?.esRows ?? []]]) {
    const l = live[fam];
    if (!l) {
      out.push(`${fam}: no live price (ATAS is not running with DL Sweep Meter on a ${fam} chart).`);
      continue;
    }
    const age = Math.round((now - new Date(l.time)) / 1000);
    const stale = age > 120 ? ` STALE: last update ${Math.round(age / 60)} min ago, market may be closed or ATAS off.` : '';
    out.push(`${fam} last ${fmt(l.price)} (${l.symbol}, ${age}s ago).${stale}`);
    for (const r of rows) {
      const z = zoneRange(r.zone);
      if (!z) continue;
      const [lo, hi] = z;
      const where = l.price < lo ? `${fmt(lo - l.price)} pts below it` : l.price > hi ? `${fmt(l.price - hi)} pts above it` : 'price is INSIDE the zone';
      out.push(`- ${r.id} (${r.side}) ${r.zone}: ${where}`);
    }
  }
  return out.join('\n');
}

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/[\r\n]+/g, ' ').slice(0, 500)}"`;
export const IDEA_HEADER = 'time,instrument,side,level,idea,jarwick_view,rule_flags,price_at_idea';

/** Settings with the playbook digest and the snapshot appended to the agent prompt, within the cap. Pure. */
export function settingsWithContext(settings, context, playbook = '', cap = PROMPT_CAP) {
  const copy = structuredClone(settings);
  const think = copy?.agent?.think;
  if (think) {
    const base = String(think.prompt ?? '').replace(/You have no live market data or access to Henrik's files yet\.[^.]*\.[^.]*\.\s*/, '');
    const digest = playbook ? playbookDigest(playbook) : '';
    const book = digest ? `${PLAYBOOK_RULES.join('\n')}\n${digest}\n` : '';
    const head = `${base}\n${book}${RULES.join('\n')}\n`;
    think.prompt = head + fitContext(String(context ?? ''), cap - head.length);
    const have = new Set((think.functions ?? []).map((f) => f.name));
    think.functions = [...(think.functions ?? []), ...HQ_FUNCTIONS.filter((f) => !have.has(f.name))];
  }
  return copy;
}

export function createHqBridge({ hqDir = process.env.HQ_DIR || DEFAULT_HQ_DIR, settings, playbookPath } = {}) {
  const root = resolve(hqDir);
  const page = join(root, 'NQ-Cockpit.html');
  const playbookFile = resolve(playbookPath || process.env.PLAYBOOK || join(root, 'PLAYBOOK.md'));

  // The playbook is re-read on every call start, so an edit to PLAYBOOK.md is live
  // on the next call with no restart. Missing file = Jarwick runs without it (logged once).
  let warnedNoPlaybook = false;
  const readPlaybook = async () => {
    try {
      return (await readFile(playbookFile, 'utf8')).trim();
    } catch (error) {
      if (!warnedNoPlaybook) {
        warnedNoPlaybook = true;
        console.warn(`HQ bridge: no playbook at ${playbookFile} (${error?.code ?? error}) - Jarwick runs without it`);
      }
      return '';
    }
  };

  const journalDir = resolve(root, '..', 'journal');
  const ideaLog = join(root, 'data', 'jarwick_ideas.csv');

  const snapshot = async () => {
    const html = await readFile(page, 'utf8');
    return buildContext(jsonBlock(html, 'nq-bias'), jsonBlock(html, 'dl-journal'), new Date(), jsonBlock(html, 'dl-wick-entries'));
  };

  const readLive = async () => {
    const live = {};
    for (const fam of ['NQ', 'ES']) {
      try {
        live[fam] = JSON.parse(await readFile(join(journalDir, `live_${fam}.json`), 'utf8'));
      } catch {
        /* no file yet */
      }
    }
    return live;
  };

  const liveText = async () => {
    const html = await readFile(page, 'utf8');
    return liveReport(jsonBlock(html, 'nq-bias'), await readLive());
  };

  const readBody = (req) =>
    new Promise((ok, fail) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
        if (data.length > 20_000) fail(new Error('body too large'));
      });
      req.on('end', () => ok(data));
      req.on('error', fail);
    });

  const logIdea = async (body) => {
    const i = JSON.parse(body || '{}');
    const live = await readLive();
    const fam = /^m?es/i.test(i.instrument ?? '') ? 'ES' : 'NQ';
    let exists = true;
    try {
      await stat(ideaLog);
    } catch {
      exists = false;
    }
    const row = [new Date().toISOString(), i.instrument, i.side, i.level, i.idea, i.view, i.flags, live[fam]?.price ?? '']
      .map(csvCell)
      .join(',');
    await appendFile(ideaLog, `${exists ? '' : `${IDEA_HEADER}\n`}${row}\n`, 'utf8');
    return 'Saved to the idea log.';
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
      if (path === '/api/hq/playbook') {
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        const book = await readPlaybook();
        res.end(url.searchParams.has('topic') ? playbookLookup(book, url.searchParams.get('topic')) : book);
        return;
      }
      if (path === '/api/hq/fill') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        const html = await readFile(page, 'utf8');
        res.end(fillReport(jsonBlock(html, 'dl-wick-entries'), jsonBlock(html, 'nq-bias'), url.searchParams.get('play')));
        return;
      }
      if (path === '/api/hq/live') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(await liveText());
        return;
      }
      if (path === '/api/hq/idea' && req.method === 'POST') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(await logIdea(await readBody(req)));
        return;
      }
      if (path === '/api/hq/agent-settings') {
        if (!settings) throw new Error('no agent settings were given to the HQ bridge');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(settingsWithContext(settings, await snapshot(), await readPlaybook())));
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
  // Braces matter: if configureServer returns a function, Vite calls it later as a post-hook.
  const install = (server) => {
    server.middlewares.use(handler);
  };
  return { name: 'jarwick-hq-bridge', configureServer: install, configurePreviewServer: install };
}
