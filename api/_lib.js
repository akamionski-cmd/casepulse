// Shared helpers for the CasePulse API routes (files starting with "_" are not routes on Vercel).

export const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
export const hasKV = !!(KV_URL && KV_TOKEN);

export class HttpError extends Error { constructor(status, message){ super(message); this.status = status; } }

/* ---------- Redis (Upstash REST) ---------- */
export async function kv(...cmd){
  if(!hasKV) throw new HttpError(503, 'Storage is not configured.');
  const r = await fetch(KV_URL, { method:'POST', headers:{ Authorization:`Bearer ${KV_TOKEN}`, 'Content-Type':'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json().catch(()=>({}));
  if(!r.ok || j.error) throw new Error('Storage error: ' + (j.error || r.status));
  return j.result;
}

/* ---------- rate limits ---------- */
const memCounts = new Map();
function clientIp(req){ return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'anon').split(',')[0].trim(); }
async function bump(key, ttl){
  if(hasKV){ const n = await kv('INCR', key); if(n === 1) await kv('EXPIRE', key, ttl); return n; }
  const n = (memCounts.get(key) || 0) + 1; memCounts.set(key, n);
  if(memCounts.size > 5000) memCounts.clear();
  return n;
}
export async function rateLimit(req, bucket, limit, windowSec){
  const slot = Math.floor(Date.now() / 1000 / windowSec);
  const n = await bump(`rl:${bucket}:${clientIp(req)}:${slot}`, windowSec + 5);
  if(n > limit) throw new HttpError(429, 'You have hit the demo limit for now. Try again in a little while.');
}
export async function dailyCap(){
  const cap = Number(process.env.DAILY_AI_CAP || 400);
  const n = await bump('cap:' + new Date().toISOString().slice(0, 10), 90000);
  if(n > cap) throw new HttpError(429, 'The demo has reached its usage limit for today. Please come back tomorrow.');
}

/* ---------- Claude ---------- */
export async function claude({ system, messages, tools, maxTokens = 6000 }){
  if(!process.env.ANTHROPIC_API_KEY) throw new HttpError(503, 'The AI is not configured on this site yet.');
  const body = { model: MODEL, max_tokens: maxTokens, messages };
  if(system) body.system = system;
  if(tools) body.tools = tools;
  const r = await fetch((process.env.ANTHROPIC_BASE_URL||'https://api.anthropic.com')+'/v1/messages', {
    method:'POST',
    headers:{ 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01', 'content-type':'application/json' },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(()=>({}));
  if(!r.ok) throw new HttpError(r.status === 429 || r.status === 529 ? 503 : 502, 'The AI service returned an error' + (j?.error?.message ? ': ' + j.error.message : '.'));
  return j;
}
export const textOf = j => (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
export function parseJSON(t){
  const s = String(t || '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fence ? fence[1] : s;
  const a = src.indexOf('{'), b = src.lastIndexOf('}');
  if(a < 0 || b < a) throw new HttpError(502, 'The AI did not return a structured answer. Try again.');
  return JSON.parse(src.slice(a, b + 1));
}
export async function askJSON(prompt, maxTokens){
  const j = await claude({ messages:[{ role:'user', content: prompt }], maxTokens });
  return parseJSON(textOf(j));
}

/* ---------- misc ---------- */
export function deepMerge(t, p){
  for(const k in p){
    const v = p[k];
    if(v && typeof v === 'object' && !Array.isArray(v) && t[k] && typeof t[k] === 'object' && !Array.isArray(t[k])) deepMerge(t[k], v);
    else t[k] = v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }
  return t;
}
export const money = n => { n = Number(n); return isFinite(n) ? n.toLocaleString('en-US', { style:'currency', currency:'USD', maximumFractionDigits:0 }) : '—'; };
export const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…[truncated]' : s; };

export function handler(fn){
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try{
      const out = await fn(req, res);
      if(!res.headersSent) res.status(200).json(out);
    }catch(e){
      const status = e.status || 500;
      if(status >= 500) console.error(e);
      res.status(status).json({ error: e.status ? e.message : 'Something went wrong on the server.' });
    }
  };
}
export function body(req){
  const b = req.body;
  if(!b) return {};
  if(typeof b === 'string'){ try{ return JSON.parse(b); }catch{ throw new HttpError(400, 'Invalid JSON.'); } }
  return b;
}

// Status transitions computed from the merged dispute, so two people acting at once can't leave it stuck.
export function advance(d){
  const c=d.consents||{}, f=d.filings||{}, q=d.questions||{}, r=d.responses||{};
  if(d.status==='consent' && c.claimant && c.respondent && c.claimant.ruleType===c.respondent.ruleType){
    d.status='pleadings';
    const bind=c.claimant.ruleType==='binding';
    d.agreed={ruleType:c.claimant.ruleType,cap:bind?Math.min(Number(c.claimant.cap)||0,Number(c.respondent.cap)||0):null};
  }
  if(d.status==='pleadings' && f.claimant?.submittedAt && f.respondent?.submittedAt) d.status='rebuttal';
  if(d.status==='rebuttal' && f.claimant?.rebuttalDone && f.respondent?.rebuttalDone) d.status='review';
  if(d.status==='questions' && q.claimantDone && q.respondentDone) d.status='deliberation';
  if(d.status==='ruled' && d.agreed?.ruleType!=='binding'){
    if(r.claimant==='reject'||r.respondent==='reject') d.status='rejected';
    else if(r.claimant==='accept'&&r.respondent==='accept') d.status='settled';
  }
  return d;
}
