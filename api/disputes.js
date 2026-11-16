import { handler, body, kv, hasKV, rateLimit, deepMerge, advance, HttpError } from './_lib.js';

// Shared storage for The Bench so two people on different devices can work the same dispute.
// Visitors are identified by a random id kept in their browser (no accounts in this demo).
const TTL = 60 * 60 * 24 * 30;           // disputes expire after 30 days
const MAX_DOC = 240000;                  // bytes per dispute
const okId = s => typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s);

async function getDoc(id){ const raw = await kv('GET', 'd:' + id); return raw ? JSON.parse(raw) : null; }
async function putDoc(id, doc){
  const s = JSON.stringify(doc);
  if(s.length > MAX_DOC) throw new HttpError(413, 'This dispute has too much material. Trim the evidence files.');
  await kv('SET', 'd:' + id, s, 'EX', TTL);
}
const pub = (id, d) => ({ id, ...d });

export default handler(async (req) => {
  if(!hasKV) throw new HttpError(503, 'Shared storage is not configured.');
  if(req.method === 'GET'){
    const { uid, code, id } = req.query || {};
    if(code){
      const did = await kv('GET', 'code:' + String(code).toUpperCase().slice(0, 12));
      const d = did ? await getDoc(did) : null;
      return { dispute: d ? pub(did, d) : null };
    }
    if(id){ if(!okId(id)) throw new HttpError(400, 'Bad id.'); const d = await getDoc(id); return { dispute: d ? pub(id, d) : null }; }
    if(!okId(uid)) throw new HttpError(400, 'Missing visitor id.');
    const ids = (await kv('SMEMBERS', 'u:' + uid)) || [];
    if(!ids.length) return { disputes: [] };
    const raws = await kv('MGET', ...ids.slice(0, 100).map(x => 'd:' + x));
    return { disputes: raws.map((r, i) => r ? pub(ids[i], JSON.parse(r)) : null).filter(Boolean) };
  }
  if(req.method !== 'POST') throw new HttpError(405, 'Use GET or POST.');
  await rateLimit(req, 'disputes', Number(process.env.WRITES_PER_HOUR || 300), 3600);
  const b = body(req);
  if(!okId(b.uid)) throw new HttpError(400, 'Missing visitor id.');

  if(b.action === 'create'){
    const data = b.data || {};
    const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    data.memberIds = [b.uid];
    const codeStr = String(data.inviteCode || '').toUpperCase().slice(0, 12);
    if(codeStr) await kv('SET', 'code:' + codeStr, id, 'EX', TTL);
    await putDoc(id, data);
    await kv('SADD', 'u:' + b.uid, id);
    return { id };
  }

  if(b.action === 'update'){
    if(!okId(b.id)) throw new HttpError(400, 'Bad id.');
    const d = await getDoc(b.id);
    if(!d) throw new HttpError(404, 'That dispute no longer exists.');
    const patch = b.patch || {};
    const member = (d.memberIds || []).includes(b.uid);
    const joining = !member && Array.isArray(patch.memberIds) && patch.memberIds.includes(b.uid)
      && patch.parties?.respondent?.uid === b.uid && (!d.parties?.respondent || d.parties.respondent.uid === b.uid);
    if(!member && !joining) throw new HttpError(403, 'You are not a party to this dispute.');
    if(Array.isArray(patch.memberIds)) patch.memberIds = [...new Set([...(d.memberIds || []), b.uid])];
    deepMerge(d, patch);
    advance(d);
    await putDoc(b.id, d);
    if(joining) await kv('SADD', 'u:' + b.uid, b.id);
    return { ok: true };
  }
  throw new HttpError(400, 'Unknown action.');
});
