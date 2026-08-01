// PaymentScreen.jsx
// Shown when a logged-in user has no active subscription. Two plan
// buttons — clicking either calls our backend to create a Razorpay
// order, then opens Razorpay Checkout (see razorpay-integration.md).

import React, { useState } from 'react';

export default function PaymentScreen({ user, onPaymentDone }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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
        description: plan === 'intro_30day' ? '30-Day Access' : 'Monthly Subscription',
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

  return (
    <div style={{ maxWidth: 420, margin: '60px auto', textAlign: 'center', fontFamily: 'system-ui, sans-serif' }}>
      <h2 style={{ fontSize: 20, marginBottom: 8 }}>Apna plan choose karo</h2>
      <p style={{ color: '#6b6b68', fontSize: 14, marginBottom: 28 }}>Profit Dashboard aur Listing Generator use karne ke liye ek plan activate karo.</p>

      <div style={{ border: '1px solid #e5e4df', borderRadius: 12, padding: 20, marginBottom: 16, textAlign: 'left' }}>
        <p style={{ fontSize: 13, color: '#6b6b68', margin: '0 0 4px' }}>Intro Offer</p>
        <p style={{ fontSize: 24, fontWeight: 600, margin: '0 0 4px' }}>₹999 <span style={{ fontSize: 14, fontWeight: 400, color: '#6b6b68' }}>/ 30 din</span></p>
        <button
          onClick={() => startPayment('intro_30day')}
          disabled={loading}
          style={{ width: '100%', marginTop: 12, background: '#0F6E56', color: '#fff', border: 'none', padding: 12, borderRadius: 8, fontSize: 14, fontWeight: 500, cursor: 'pointer' }}
        >
          ₹999 se shuru karo
        </button>
      </div>

      <div style={{ border: '1px solid #e5e4df', borderRadius: 12, padding: 20, textAlign: 'left' }}>
        <p style={{ fontSize: 13, color: '#6b6b68', margin: '0 0 4px' }}>Monthly</p>
        <p style={{ fontSize: 24, fontWeight: 600, margin: '0 0 4px' }}>₹300 <span style={{ fontSize: 14, fontWeight: 400, color: '#6b6b68' }}>/ month</span></p>
        <button
          onClick={() => startPayment('monthly')}
          disabled={loading}
          style={{ width: '100%', marginTop: 12, background: 'transparent', color: '#0F6E56', border: '1px solid #0F6E56', padding: 12, borderRadius: 8, fontSize: 14, fontWeight: 500, cursor: 'pointer' }}
        >
          Monthly subscribe karo
        </button>
      </div>

      {error && <p style={{ color: '#A32D2D', fontSize: 13, marginTop: 16 }}>{error}</p>}
    </div>
  );
}
