// PaymentScreen.jsx
// Shown when a logged-in user has no active subscription. Plan options:
//   - Full 30-day access: ₹999
//   - 7-day trial: ₹299
//   - Top-up (only shown if the user's last plan was the trial): ₹700,
//     extends the trial to a full 30 days (₹299 + ₹700 = ₹999 total)
//   - Monthly renewal: ₹300 (shown for everyone as a lighter recurring option)
//
// Clicking a button calls our backend to create a Razorpay order, then
// opens Razorpay Checkout (see razorpay-integration.md).

import React, { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';

export default function PaymentScreen({ user, onPaymentDone }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastPlan, setLastPlan] = useState(null); // 'trial_7day' | 'full_30day' | 'monthly' | null

  useEffect(() => {
    supabase
      .from('subscriptions')
      .select('plan_type, expires_at')
      .eq('user_id', user.id)
      .order('expires_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => setLastPlan(data?.plan_type ?? null));
  }, [user.id]);

  const startPayment = async (plan) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, userId: user.id }),
      });
      const order = await res.json();

      const options = {
        key: import.meta.env.VITE_RAZORPAY_KEY_ID,
        amount: order.amount,
        currency: 'INR',
        name: 'GetDigitals Seller Doctor',
        description:
          plan === 'full_30day' ? '30-Day Full Access' :
          plan === 'trial_7day' ? '7-Day Trial' :
          plan === 'topup_23day' ? 'Trial Top-up (23 more days)' :
          'Monthly Subscription',
        order_id: order.id,
        handler: function () {
          // The webhook activates the subscription in the database — this
          // just polls once after a short delay so the UI updates without
          // needing a manual page refresh.
          setTimeout(() => onPaymentDone(), 3000);
        },
        prefill: { email: user.email },
        theme: { color: '#0F6E56' },
      };
      const rzp = new window.Razorpay(options);
      rzp.open();
    } catch (err) {
      setError('Payment start nahi ho paya — dobara try karo.');
    } finally {
      setLoading(false);
    }
  };

  const showTopup = lastPlan === 'trial_7day';

  return (
    <div style={{ maxWidth: 420, margin: '60px auto', textAlign: 'center', fontFamily: 'system-ui, sans-serif' }}>
      <h2 style={{ fontSize: 20, marginBottom: 8 }}>Apna plan choose karo</h2>
      <p style={{ color: '#6b6b68', fontSize: 14, marginBottom: 28 }}>Profit Dashboard aur Listing Generator use karne ke liye ek plan activate karo.</p>

      {showTopup && (
        <div style={{ border: '1px solid #0F6E56', background: '#EAF6F2', borderRadius: 12, padding: 20, marginBottom: 16, textAlign: 'left' }}>
          <p style={{ fontSize: 13, color: '#0F6E56', margin: '0 0 4px', fontWeight: 500 }}>Trial ko Full Month banao</p>
          <p style={{ fontSize: 24, fontWeight: 600, margin: '0 0 4px' }}>₹700 <span style={{ fontSize: 14, fontWeight: 400, color: '#6b6b68' }}>top-up / baaki 23 din</span></p>
          <p style={{ fontSize: 12, color: '#6b6b68', margin: '0 0 8px' }}>Tumhare 7-din trial mein ₹700 add karke poore 30 din ka access mil jayega (total ₹999).</p>
          <button
            onClick={() => startPayment('topup_23day')}
            disabled={loading}
            style={{ width: '100%', marginTop: 4, background: '#0F6E56', color: '#fff', border: 'none', padding: 12, borderRadius: 8, fontSize: 14, fontWeight: 500, cursor: 'pointer' }}
          >
            ₹700 top-up karo
          </button>
        </div>
      )}

      <div style={{ border: '1px solid #e5e4df', borderRadius: 12, padding: 20, marginBottom: 16, textAlign: 'left' }}>
        <p style={{ fontSize: 13, color: '#6b6b68', margin: '0 0 4px' }}>Full Access</p>
        <p style={{ fontSize: 24, fontWeight: 600, margin: '0 0 4px' }}>₹999 <span style={{ fontSize: 14, fontWeight: 400, color: '#6b6b68' }}>/ 30 din</span></p>
        <button
          onClick={() => startPayment('full_30day')}
          disabled={loading}
          style={{ width: '100%', marginTop: 12, background: '#0F6E56', color: '#fff', border: 'none', padding: 12, borderRadius: 8, fontSize: 14, fontWeight: 500, cursor: 'pointer' }}
        >
          ₹999 se 30 din access lo
        </button>
      </div>

      {!showTopup && (
        <div style={{ border: '1px solid #e5e4df', borderRadius: 12, padding: 20, marginBottom: 16, textAlign: 'left' }}>
          <p style={{ fontSize: 13, color: '#6b6b68', margin: '0 0 4px' }}>Trial</p>
          <p style={{ fontSize: 24, fontWeight: 600, margin: '0 0 4px' }}>₹299 <span style={{ fontSize: 14, fontWeight: 400, color: '#6b6b68' }}>/ 7 din</span></p>
          <p style={{ fontSize: 12, color: '#6b6b68', margin: '0 0 8px' }}>Baad mein ₹700 top-up karke poore mahine tak badha sakte ho.</p>
          <button
            onClick={() => startPayment('trial_7day')}
            disabled={loading}
            style={{ width: '100%', marginTop: 4, background: 'transparent', color: '#0F6E56', border: '1px solid #0F6E56', padding: 12, borderRadius: 8, fontSize: 14, fontWeight: 500, cursor: 'pointer' }}
          >
            ₹299 mein trial lo
          </button>
        </div>
      )}

      <div style={{ border: '1px solid #e5e4df', borderRadius: 12, padding: 20, textAlign: 'left' }}>
        <p style={{ fontSize: 13, color: '#6b6b68', margin: '0 0 4px' }}>Monthly Renewal</p>
        <p style={{ fontSize: 24, fontWeight: 600, margin: '0 0 4px' }}>₹300 <span style={{ fontSize: 14, fontWeight: 400, color: '#6b6b68' }}>/ month</span></p>
        <p style={{ fontSize: 12, color: '#6b6b68', margin: '0 0 8px' }}>Pehle mahine (₹999 wale) ke baad, har mahine renew karne ke liye.</p>
        <button
          onClick={() => startPayment('monthly')}
          disabled={loading}
          style={{ width: '100%', marginTop: 4, background: 'transparent', color: '#0F6E56', border: '1px solid #0F6E56', padding: 12, borderRadius: 8, fontSize: 14, fontWeight: 500, cursor: 'pointer' }}
        >
          ₹300 monthly subscribe karo
        </button>
      </div>

      {error && <p style={{ color: '#A32D2D', fontSize: 13, marginTop: 16 }}>{error}</p>}
    </div>
  );
}
