import { handler, body, rateLimit, dailyCap, claude, textOf, parseJSON, clip, HttpError } from './_lib.js';
import { researchPrompt } from './_prompts.js';

// Comparable-verdict research: Claude decides what to search, the server runs the searches
// against CourtListener and Parallel Search, and only links that came back from those
// searches are allowed through to the page.

const baseUrl = u => String(u || '').split('?')[0].split('#')[0].replace(/\/+$/, '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '');

const TOOLS = [
  { name:'courtlistener_search',
    description:'Search CourtListener case law (federal and state appellate and trial-court opinions). Best for verdict amounts discussed in remittitur, new-trial and appeal decisions. Returns case name, court, date, URL and a text snippet.',
    input_schema:{ type:'object', properties:{ q:{ type:'string' }, semantic:{ type:'boolean', description:'true for a plain-English conceptual query' }, filed_after:{ type:'string', description:'YYYY-MM-DD' } }, required:['q'] } },
  { name:'web_news_search',
    description:'Search the web for news, verdict reports and trade press. Give an objective and 2-3 short keyword queries (3-6 words, no quotes). Returns titles, URLs, publish dates and excerpts.',
    input_schema:{ type:'object', properties:{ objective:{ type:'string' }, queries:{ type:'array', items:{ type:'string' } } }, required:['objective','queries'] } }
];

async function courtListener(i, seen){
  const p = new URLSearchParams({ q: clip(String(i.q || ''), 300), type: 'o' });
  if(i.semantic !== false) p.set('semantic', 'true');
  if(i.filed_after) p.set('filed_after', String(i.filed_after).slice(0, 10));
  const headers = { Accept: 'application/json' };
  if(process.env.COURTLISTENER_TOKEN) headers.Authorization = `Token ${process.env.COURTLISTENER_TOKEN}`;
  const r = await fetch(`${process.env.COURTLISTENER_BASE_URL||'https://www.courtlistener.com'}/api/rest/v4/search/?${p}`, { headers });
  if(!r.ok) throw new Error(`CourtListener returned ${r.status}`);
  const j = await r.json();
  const out = (j.results || []).slice(0, 8).map(x => ({
    case: x.caseName, court: x.court, date: x.dateFiled,
    url: 'https://www.courtlistener.com' + (x.absolute_url || ''),
    snippet: clip((x.opinions && x.opinions[0] && x.opinions[0].snippet) || '', 500)
  }));
  out.forEach(o => seen.add(baseUrl(o.url)));
  return out;
}

async function parallelSearch(i, seen){
  if(!process.env.PARALLEL_API_KEY) throw new Error('web search is not configured');
  const qs = (Array.isArray(i.queries) ? i.queries : [i.objective]).map(q => String(q).replace(/"/g, '').slice(0, 200)).filter(Boolean).slice(0, 3);
  const r = await fetch((process.env.PARALLEL_BASE_URL||'https://api.parallel.ai')+'/v1/search', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'x-api-key': process.env.PARALLEL_API_KEY },
    body: JSON.stringify({ objective: clip(String(i.objective || qs[0] || ''), 1000), search_queries: qs.length ? qs : ['verdict news'], mode:'fast', max_chars_total: 12000 })
  });
  if(!r.ok) throw new Error(`Parallel returned ${r.status}`);
  const j = await r.json();
  const out = (j.results || []).slice(0, 8).map(x => ({ title: x.title, url: x.url, date: x.publish_date, excerpt: clip((x.excerpts || []).join(' … ').replace(/\s+/g, ' '), 900) }));
  out.forEach(o => seen.add(baseUrl(o.url)));
  return out;
}

export default handler(async (req) => {
  if(req.method !== 'POST') throw new HttpError(405, 'Use POST.');
  const b = body(req);
  if(!b.input || typeof b.input !== 'object') throw new HttpError(400, 'Missing case input.');
  await rateLimit(req, 'research', Number(process.env.RESEARCH_PER_HOUR || 12), 3600);
  await dailyCap();

  const seen = new Set();
  const sources = { CourtListener: null, Trellis: 'not_configured', 'Parallel Search': process.env.PARALLEL_API_KEY ? null : 'not_configured' };
  const messages = [{ role:'user', content: researchPrompt(b) }];

  let final = null;
  for(let round = 0; round < 6; round++){
    const resp = await claude({ messages, tools: TOOLS, maxTokens: 3000 });
    messages.push({ role:'assistant', content: resp.content });
    const calls = (resp.content || []).filter(c => c.type === 'tool_use');
    if(!calls.length || resp.stop_reason !== 'tool_use'){ final = textOf(resp); break; }
    const results = await Promise.all(calls.map(async c => {
      try{
        let out;
        if(c.name === 'courtlistener_search'){ out = await courtListener(c.input || {}, seen); sources.CourtListener = 'ok'; }
        else if(c.name === 'web_news_search'){ out = await parallelSearch(c.input || {}, seen); sources['Parallel Search'] = 'ok'; }
        else throw new Error('unknown tool');
        return { type:'tool_result', tool_use_id: c.id, content: clip(JSON.stringify(out), 10000) };
      }catch(e){
        if(c.name === 'courtlistener_search' && sources.CourtListener !== 'ok') sources.CourtListener = 'error';
        if(c.name === 'web_news_search' && sources['Parallel Search'] !== 'ok') sources['Parallel Search'] = sources['Parallel Search'] || 'error';
        return { type:'tool_result', tool_use_id: c.id, content: 'Error: ' + e.message, is_error: true };
      }
    }));
    messages.push({ role:'user', content: results });
    if(round === 4) messages.push({ role:'user', content: 'Stop searching now and return the final JSON.' });
  }
  if(final === null) throw new HttpError(502, 'Research did not finish. Try again.');

  let r;
  r = parseJSON(final); if(!r){ return { sources, data:null, err:'Research came back in an unreadable form. The valuation will run without it.' }; }
  const ok = u => u && seen.has(baseUrl(u));
  const comparables = (Array.isArray(r.comparables) ? r.comparables : []).filter(x => x && ok(x.url)).slice(0, 6);
  const news = (Array.isArray(r.news) ? r.news : []).filter(x => x && ok(x.url)).slice(0, 4);
  const dropped = ((r.comparables || []).length + (r.news || []).length) - (comparables.length + news.length);
  return { sources, err:null, data:{ comparables, news, nuclear_signal: r.nuclear_signal || null, summary: String(r.summary || ''), gaps: String(r.gaps || ''), dropped } };
});
