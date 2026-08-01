// netlify/functions/create-order.js
const Razorpay = require('razorpay');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { plan, userId } = JSON.parse(event.body);

    // Amounts in paise (₹1 = 100 paise).
    //   full_30day        → ₹999, full 30-day access
    //   trial_7day        → ₹299, 7-day trial
    //   topup_23day       → ₹700, extends an active trial to a full 30 days
    //                       (₹299 + ₹700 = ₹999, same as buying full_30day directly)
    //   monthly           → ₹300, recurring renewal after the first 30 days
    //   monthly_discounted→ ₹270, same as monthly but with a 10% "renew early"
    //                       bonus — only offered when the user renews while
    //                       still inside their 3-day expiry warning window
    //                       (enforced/checked on the frontend in PaymentScreen.jsx)
    const AMOUNTS = {
      full_30day: 99900,
      trial_7day: 29900,
      topup_23day: 70000,
      monthly: 30000,
      monthly_discounted: 27000,
    };
    const amount = AMOUNTS[plan];
    if (!amount) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid plan' }) };
    }

    const order = await razorpay.orders.create({
      amount,
      currency: 'INR',
      notes: { userId, plan },
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
