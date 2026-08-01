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
  const expiresAt = new Date(now);
  if (plan === 'intro_30day') expiresAt.setDate(now.getDate() + 30);
  else expiresAt.setMonth(now.getMonth() + 1);

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
