import { handler, body, rateLimit, dailyCap, askJSON, HttpError } from './_lib.js';
import { valuePrompt, questionsPrompt, rulingPrompt, answersPrompt } from './_prompts.js';

// One endpoint, fixed tasks. The server builds every prompt, so the site cannot be used as an open AI proxy.
export default handler(async (req) => {
  if(req.method !== 'POST') throw new HttpError(405, 'Use POST.');
  const b = body(req);
  if(JSON.stringify(b).length > 400000) throw new HttpError(413, 'That is too much material for one request. Trim the uploaded files and try again.');
  await rateLimit(req, 'ai', Number(process.env.AI_PER_HOUR || 40), 3600);
  await dailyCap();
  switch(b.task){
    case 'value':
      if(!b.input || typeof b.input !== 'object') throw new HttpError(400, 'Missing case input.');
      return { result: await askJSON(valuePrompt(b), 6000) };
    case 'questions':
      if(!b.dispute) throw new HttpError(400, 'Missing dispute.');
      return { result: await askJSON(questionsPrompt(b.dispute), 1500) };
    case 'ruling':
      if(!b.dispute) throw new HttpError(400, 'Missing dispute.');
      return { result: await askJSON(rulingPrompt(b.dispute), 5000) };
    case 'answers':
      return { result: await askJSON(answersPrompt(b), 1200) };
    default:
      throw new HttpError(400, 'Unknown task.');
  }
});
