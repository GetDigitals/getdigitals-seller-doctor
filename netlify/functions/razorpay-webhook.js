// netlify/functions/razorpay-webhook.js
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // Verify the webhook really came from Razorpay, not a spoofed request.
  const signature = event.headers['x-razorpay-signature'];
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(event.body)
    .digest('hex');
  if (signature !== expected) {
    return { statusCode: 400, body: 'Invalid signature' };
  }

  const payload = JSON.parse(event.body);
  if (payload.event !== 'payment.captured') {
    return { statusCode: 200, body: 'Ignored' };
  }

  const { userId, plan } = payload.payload.payment.entity.notes;
  const now = new Date();

  // topup_23day is special: it doesn't create a new subscription, it
  // extends the user's existing trial (started with trial_7day) so the
  // two payments together (₹299 + ₹700 = ₹999) add up to a full 30 days
  // from when the trial originally started.
  if (plan === 'topup_23day') {
    const { data: existing, error: findErr } = await supabase
      .from('subscriptions')
      .select('id, expires_at')
      .eq('user_id', userId)
      .order('expires_at', { ascending: false })
      .limit(1)
      .single();

    if (findErr || !existing) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No existing trial found to top up' }) };
    }

    const newExpiry = new Date(existing.expires_at);
    newExpiry.setDate(newExpiry.getDate() + 23);

    const { error: updateErr } = await supabase
      .from('subscriptions')
      .update({
        plan_type: 'full_30day',
        expires_at: newExpiry.toISOString(),
        razorpay_payment_id: payload.payload.payment.entity.id,
      })
      .eq('id', existing.id);

    if (updateErr) {
      return { statusCode: 500, body: JSON.stringify({ error: updateErr.message }) };
    }
    return { statusCode: 200, body: 'OK' };
  }

  // full_30day, trial_7day, and monthly all create a fresh subscription
  // row that starts now.
  const DURATIONS_DAYS = { full_30day: 30, trial_7day: 7, monthly: 30 };
  const days = DURATIONS_DAYS[plan];
  if (!days) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown plan type' }) };
  }
  const expiresAt = new Date(now);
  expiresAt.setDate(now.getDate() + days);

  const { error } = await supabase.from('subscriptions').insert({
    user_id: userId,
    plan_type: plan,
    status: 'active',
    razorpay_payment_id: payload.payload.payment.entity.id,
    started_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  });

  if (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }

  return { statusCode: 200, body: 'OK' };
};
