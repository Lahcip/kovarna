// Cloudflare Pages Function — proxy na Groq, klíč je v env proměnné GROQ_KEY (ne v kódu)
export async function onRequestPost({ request, env }) {
  if (!env.GROQ_KEY) {
    return new Response(JSON.stringify({ error: 'GROQ_KEY není nastavený v Cloudflare' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
  const body = await request.text();
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.GROQ_KEY },
    body
  });
  return new Response(await r.text(), { status: r.status, headers: { 'Content-Type': 'application/json' } });
}
