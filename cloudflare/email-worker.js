// Cloudflare Email Worker: receives mail for free-foods@notaroomba.dev and hands the raw
// RFC822 bytes to the app. Deploy from the Cloudflare dashboard (Workers & Pages -> Create -> paste),
// set variables INGEST_URL = https://free-foods.notaroomba.dev/ingest and INGEST_TOKEN (secret),
// then Email Routing -> Routing rules -> free-foods@notaroomba.dev -> "Send to a Worker" -> this worker.
export default {
  async email(message, env) {
    const raw = await new Response(message.raw).arrayBuffer();
    const r = await fetch(env.INGEST_URL, {
      method: 'POST',
      headers: { 'content-type': 'message/rfc822', authorization: `Bearer ${env.INGEST_TOKEN}`, 'x-envelope-from': message.from, 'x-envelope-to': message.to },
      body: raw,
    });
    if (!r.ok) message.setReject(`ingest failed: ${r.status}`); // Cloudflare does not retry; a reject bounces so the failure is visible
  },
};
