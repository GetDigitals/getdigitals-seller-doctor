// worker/index.js
//
// Single Cloudflare Worker that serves the built React app (via the
// ASSETS binding) and also handles the small serverless endpoints that
// used to be separate Netlify Functions:
//   POST /api/create-order                    -> create a Razorpay order
//   POST /.netlify/functions/claude-proxy      -> AI proxy (Gemini)
//   POST /.netlify/functions/razorpay-webhook  -> Razorpay payment webhook
//
// The last two paths are kept identical to their old Netlify paths on
// purpose, so the frontend code (SellerDoctorTool.jsx) and the webhook
// URL already configured in the Razorpay dashboard don't need to change
// — only the domain in front of them does.
//
// Required Worker secrets (set in Cloudflare dashboard > Settings > Variables
// and Secrets, or via `wrangler secret put <NAME>`):
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET,
//   GEMINI_API_KEY, SUPABASE_SERVICE_ROLE_KEY, VITE_SUPABASE_URL
//
// Note: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, and VITE_RAZORPAY_KEY_ID
// are also needed as *build-time* variables (not just runtime secrets),
// because Vite bakes import.meta.env.VITE_* values into the frontend
// bundle at build time.

const AMOUNTS = {
  full_30day: 99900,
  trial_7day: 29900,
  topup_23day: 70000,
  monthly: 30000,
  monthly_discounted: 27000,
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleCreateOrder(request, env) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  try {
    const { plan, userId } = await request.json();
    const amount = AMOUNTS[plan];
    if (!amount) return json({ error: 'Invalid plan' }, 400);

    const auth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        amount,
        currency: 'INR',
        notes: { userId, plan },
      }),
    });
    const order = await res.json();
    if (!res.ok) {
      return json({ error: order?.error?.description || 'Razorpay error' }, res.status);
    }
    return json(order);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

async function handleClaudeProxy(request, env) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  try {
    const { max_tokens, messages } = await request.json();

    // Gemini's current stable Flash model (as of Aug 2026).
    const GEMINI_MODEL = 'gemini-3.6-flash';

    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
    }));

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        generationConfig: {
          maxOutputTokens: Math.max(max_tokens || 0, 4096),
          thinkingConfig: { thinkingLevel: 'minimal' },
        },
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      return json({ error: { message: data?.error?.message || 'Gemini API error' } }, res.status);
    }

    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    return json({ content: [{ type: 'text', text }] });
  } catch (err) {
    return json({ error: { message: 'Proxy error: ' + err.message } }, 500);
  }
}

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function supabaseRest(env, path, options = {}) {
  return fetch(`${env.VITE_SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {}),
    },
  });
}

async function handleRazorpayWebhook(request, env) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const rawBody = await request.text();
  const signature = request.headers.get('x-razorpay-signature');
  const expected = await hmacSha256Hex(env.RAZORPAY_WEBHOOK_SECRET, rawBody);
  if (signature !== expected) {
    return new Response('Invalid signature', { status: 400 });
  }

  const payload = JSON.parse(rawBody);
  if (payload.event !== 'payment.captured') {
    return new Response('Ignored', { status: 200 });
  }

  const { userId, plan } = payload.payload.payment.entity.notes;
  const now = new Date();

  // topup_23day is special: it doesn't create a new subscription, it
  // extends the user's existing trial (started with trial_7day) so the
  // two payments together (₹299 + ₹700 = ₹999) add up to a full 30 days
  // from when the trial originally started.
  if (plan === 'topup_23day') {
    const findRes = await supabaseRest(
      env,
      `subscriptions?user_id=eq.${userId}&select=id,expires_at&order=expires_at.desc&limit=1`
    );
    const existing = (await findRes.json())?.[0];
    if (!existing) {
      return json({ error: 'No existing trial found to top up' }, 400);
    }

    const newExpiry = new Date(existing.expires_at);
    newExpiry.setDate(newExpiry.getDate() + 23);

    const updateRes = await supabaseRest(env, `subscriptions?id=eq.${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        plan_type: 'full_30day',
        expires_at: newExpiry.toISOString(),
        razorpay_payment_id: payload.payload.payment.entity.id,
      }),
    });
    if (!updateRes.ok) {
      return json({ error: await updateRes.text() }, 500);
    }
    return new Response('OK', { status: 200 });
  }

  // full_30day, trial_7day, and monthly all create a fresh subscription
  // row that starts now. monthly_discounted is normalized to "monthly".
  const DURATIONS_DAYS = { full_30day: 30, trial_7day: 7, monthly: 30, monthly_discounted: 30 };
  const days = DURATIONS_DAYS[plan];
  if (!days) return json({ error: 'Unknown plan type' }, 400);

  const expiresAt = new Date(now);
  expiresAt.setDate(now.getDate() + days);
  const normalizedPlanType = plan === 'monthly_discounted' ? 'monthly' : plan;

  const insertRes = await supabaseRest(env, 'subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      user_id: userId,
      plan_type: normalizedPlanType,
      status: 'active',
      razorpay_payment_id: payload.payload.payment.entity.id,
      started_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    }),
  });
  if (!insertRes.ok) {
    return json({ error: await insertRes.text() }, 500);
  }
  return new Response('OK', { status: 200 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/create-order') return handleCreateOrder(request, env);
    if (url.pathname === '/.netlify/functions/claude-proxy') return handleClaudeProxy(request, env);
    if (url.pathname === '/.netlify/functions/razorpay-webhook') return handleRazorpayWebhook(request, env);

    // Everything else: serve the built static app (dist/). With
    // assets.not_found_handling = "single-page-application" set in
    // wrangler.jsonc, unknown routes fall back to index.html automatically,
    // so client-side routes (e.g. refreshing /listing) still work.
    return env.ASSETS.fetch(request);
  },
};
