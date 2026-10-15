// Cloudflare Pages Function — proxy na Groq.
// Klíč je v env proměnné GROQ_KEY (ne v kódu).
// Model si proxy vybírá sama: zkouší kandidáty v pořadí a první, který odpoví textem, vyhraje.
// Když Groq nějaký model zruší, appka jede dál na dalším — není potřeba nic měnit.

const GROQ = 'https://api.groq.com/openai/v1';

// reasoning:true = model "přemýšlí" a tokeny na přemýšlení se počítají do limitu,
// proto dostane úsporné nastavení a vyšší strop tokenů (jinak vrací prázdnou odpověď).
const CANDIDATES = [
  { model: 'llama-3.3-70b-versatile' },
  { model: 'openai/gpt-oss-120b', reasoning: true, extra: { reasoning_effort: 'low', include_reasoning: false } },
  { model: 'openai/gpt-oss-20b', reasoning: true, extra: { reasoning_effort: 'low', include_reasoning: false } },
  { model: 'qwen/qwen3.8-27b', reasoning: true, extra: { reasoning_effort: 'none' } },
  { model: 'llama-3.1-8b-instant' },
];

const NOT_CHAT = /whisper|tts|guard|safeguard|embed|playai|orpheus|distil/i;

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function cleanText(t) {
  return String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

async function callGroq(key, body) {
  const r = await fetch(GROQ + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) {}
  return { ok: r.ok, status: r.status, text, data };
}

function buildBody(base, cand, withExtra) {
  const b = { ...base, model: cand.model };
  if (cand.reasoning) {
    const want = Math.max(Number(base.max_tokens || base.max_completion_tokens || 0), 400);
    delete b.max_tokens;
    b.max_completion_tokens = want + 2500; // rezerva na přemýšlení
    if (withExtra && cand.extra) Object.assign(b, cand.extra);
  }
  return b;
}

// Vrací Response při úspěchu nebo při chybě klíče, jinak null (= zkus další model).
async function tryCandidate(key, base, cand, errors) {
  const variants = cand.reasoning && cand.extra ? [true, false] : [false];
  for (const withExtra of variants) {
    const res = await callGroq(key, buildBody(base, cand, withExtra));
    if (res.ok && res.data) {
      const msg = res.data.choices && res.data.choices[0] && res.data.choices[0].message;
      const content = cleanText(msg && msg.content);
      if (content) {
        msg.content = content;
        return json(res.data, 200, { 'X-Model': cand.model });
      }
      errors.push({ model: cand.model, status: 200, error: 'prázdná odpověď' });
      continue;
    }
    const m = (res.data && res.data.error && res.data.error.message) || res.text.slice(0, 200);
    errors.push({ model: cand.model, status: res.status, error: m });
    // špatný klíč nemá smysl zkoušet dál
    if (res.status === 401 || res.status === 403) {
      return json({ error: { message: 'Groq klíč neplatí (' + res.status + '): ' + m } }, res.status);
    }
    // model neexistuje nebo má vyčerpaný limit -> rovnou další kandidát
    if (res.status === 404 || res.status === 429 || /model_not_found|does not exist|decommissioned/i.test(m)) break;
    // jiná chyba (typicky neznámý parametr) -> zkusit stejný model bez extra parametrů
  }
  return null;
}

export async function onRequestPost({ request, env }) {
  if (!env.GROQ_KEY) return json({ error: { message: 'GROQ_KEY není nastavený v Cloudflare' } }, 500);

  let base;
  try { base = JSON.parse(await request.text()); } catch (e) { return json({ error: { message: 'Neplatný požadavek' } }, 400); }

  const errors = [];
  const tried = new Set();

  for (const cand of CANDIDATES) {
    tried.add(cand.model);
    const out = await tryCandidate(env.GROQ_KEY, base, cand, errors);
    if (out) return out;
  }

  // Poslední záchrana: zeptat se Groqu, jaké modely teď existují, a zkusit ty neznámé.
  try {
    const r = await fetch(GROQ + '/models', { headers: { Authorization: 'Bearer ' + env.GROQ_KEY } });
    const list = (await r.json()).data || [];
    const extra = list.map(m => m.id).filter(id => id && !tried.has(id) && !NOT_CHAT.test(id)).slice(0, 4);
    for (const id of extra) {
      const out = await tryCandidate(env.GROQ_KEY, base, { model: id, reasoning: true }, errors);
      if (out) return out;
    }
  } catch (e) {
    errors.push({ model: '(seznam modelů)', error: String((e && e.message) || e) });
  }

  const limited = errors.some(e => e.status === 429);
  return json({
    error: {
      message: limited ? 'Vyčerpaný limit Groq, zkus to později.' : 'Žádný Groq model neodpověděl.',
      tried: errors,
    },
  }, limited ? 429 : 502);
}
