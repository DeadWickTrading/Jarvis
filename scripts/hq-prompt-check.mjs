// Prompt check: prints the WICK lines and the prompt size Jarwick would get. Run: node scripts/hq-prompt-check.mjs

import { readFile } from 'node:fs/promises';
import { jsonBlock, buildContext, settingsWithContext } from '../server/hq-bridge.mjs';
const html = await readFile(process.env.HOME + '/Claude/Projects/DeadWick Labs/NQ-Cockpit/NQ-Cockpit.html','utf8');
const ctx = buildContext(jsonBlock(html,'nq-bias'), jsonBlock(html,'dl-journal'), new Date(), jsonBlock(html,'dl-wick-entries'));
console.log(ctx.split('\n').filter(l=>l.startsWith('WICK')).join('\n'));
const book = await readFile(process.env.HOME + '/Claude/Projects/DeadWick Labs/NQ-Cockpit/PLAYBOOK.md','utf8');
const s = settingsWithContext({agent:{think:{prompt:'x',functions:[]}}}, ctx, book);
const p = s.agent.think.prompt; console.log('PROMPT', p.length, 'ctx', ctx.length, 'T lines', (p.match(/^T /gm)||[]).length, 'DETAIL', (p.match(/^TRADE DETAIL/gm)||[]).length);
