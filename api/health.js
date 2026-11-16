import { handler, hasKV } from './_lib.js';

// Tells the page which features are switched on, without exposing any keys.
export default handler(async () => ({
  ai: !!process.env.ANTHROPIC_API_KEY,
  shared: hasKV,
  news: !!process.env.PARALLEL_API_KEY,
  courtlistener: true
}));
