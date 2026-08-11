// AuthGuard.jsx
// The gatekeeper component. Wrap your whole app in this:
//
//   <AuthGuard>
//     <SellerDoctorApp />
//   </AuthGuard>
//
// It handles three states in order:
//   1. Not logged in           → show Auth (login/signup)
//   2. Logged in, not paid     → show PaymentScreen
//   3. Logged in, active plan  → show the actual children (the tool)

import React, { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';
import Auth from './Auth';
import PaymentScreen from './PaymentScreen';

// Emails in this list always get full access, no payment/subscription
// needed — used for the owner/admin to test and use the tool for free.
// Add more emails here (comma-separated) if other people need free access.
const ADMIN_EMAILS = ['tailorashok897@gmail.com'];

export default function AuthGuard({ children }) {
  const [user, setUser] = useState(null);
  const [hasAccess, setHasAccess] = useState(null); // null = still checking
  const [checking, setChecking] = useState(true);
  const [daysLeft, setDaysLeft] = useState(null); // days until current plan expires (null = unknown/not applicable)
  const [showPayment, setShowPayment] = useState(false); // payment shown as an on-demand overlay now, not a hard block

  useEffect(() => {
    // On first load, check if there's already a logged-in session
    // (so refreshing the page doesn't log the user out).
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setChecking(false);
    });

    // Keep listening for login/logout changes.
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) {
      setHasAccess(null);
      return;
    }
    // Admins skip the subscription check entirely — always full access.
    if (ADMIN_EMAILS.includes(user.email)) {
      setHasAccess(true);
      return;
    }

    const checkAccess = () => {
      // Ask the database (via the helper function from the SQL schema)
      // whether this specific user currently has an active, unexpired plan.
      supabase.rpc('has_active_subscription', { check_user_id: user.id }).then(({ data }) => {
        const active = !!data;
        setHasAccess(active);
        // If someone was mid-session (tab left open, never refreshed) and
        // their plan just expired, kick them out immediately — don't wait
        // for them to reload the page.
        if (!active && hasAccess === true) {
          supabase.auth.signOut();
        }
      });

      // Separately fetch the actual expiry date of their latest active
      // plan, so we can show a "X din mein expire" warning banner.
      supabase
        .from('subscriptions')
        .select('expires_at')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .order('expires_at', { ascending: false })
        .limit(1)
        .maybeSingle()
        .then(({ data }) => {
          if (!data?.expires_at) {
            setDaysLeft(null);
            return;
          }
          const msLeft = new Date(data.expires_at).getTime() - Date.now();
          setDaysLeft(Math.ceil(msLeft / (1000 * 60 * 60 * 24)));
        });
    };

    checkAccess();
    // Re-check every 2 minutes so an expiry is caught within a couple of
    // minutes even if the tab is left open indefinitely.
    const interval = setInterval(checkAccess, 2 * 60 * 1000);
    return () => clearInterval(interval);
  }, [user]);

  if (checking) {
    return <div style={{ textAlign: 'center', marginTop: 80, fontFamily: 'system-ui, sans-serif', color: '#6b6b68' }}>Loading...</div>;
  }

  if (!user) {
    return <Auth onLoggedIn={setUser} />;
  }

  if (hasAccess === null) {
    return <div style={{ textAlign: 'center', marginTop: 80, fontFamily: 'system-ui, sans-serif', color: '#6b6b68' }}>Checking your subscription...</div>;
  }

  // Unpaid users used to get a hard paywall here instead of the app —
  // now they always see the real tool (children, e.g. SellerDoctorTool),
  // with hasAccess/onRequestPayment passed down so IT decides per-feature
  // what's locked. Payment only appears as an on-demand overlay when a
  // locked feature is tapped, or via the renew banner below.
  return (
    <div>
      {!hasAccess && (
        <div style={{ background: '#FFF4E5', borderBottom: '1px solid #F0C36D', padding: '10px 16px', textAlign: 'center', fontFamily: 'system-ui, sans-serif' }}>
          <span style={{ fontSize: 13, color: '#8A5A00' }}>🔒 Free calculator abhi try karo — baaki features ke liye ek plan activate karo.</span>
        </div>
      )}
      {hasAccess && daysLeft !== null && daysLeft <= 3 && (
        <div style={{ background: '#FFF4E5', borderBottom: '1px solid #F0C36D', padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, flexWrap: 'wrap', fontFamily: 'system-ui, sans-serif' }}>
          <span style={{ fontSize: 13, color: '#8A5A00' }}>
            ⚠️ Aapka subscription {daysLeft <= 0 ? 'aaj' : `${daysLeft} din mein`} expire ho raha hai — abhi renew karo aur 10% bonus discount pao!
          </span>
          <button
            onClick={() => setShowPayment(true)}
            style={{ fontSize: 12, background: '#0F6E56', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontWeight: 500 }}
          >
            Abhi Renew Karo
          </button>
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 16px', borderBottom: '1px solid #e5e4df', fontFamily: 'system-ui, sans-serif' }}>
        <span style={{ fontSize: 12, color: '#9a9a95', marginRight: 12, alignSelf: 'center' }}>{user.email}</span>
        <button
          onClick={() => supabase.auth.signOut()}
          style={{ fontSize: 12, color: '#6b6b68', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
        >
          Logout
        </button>
      </div>
      {React.cloneElement(children, { hasAccess, onRequestPayment: () => setShowPayment(true) })}

      {showPayment && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, overflowY: 'auto' }}>
          <div style={{ background: '#fff', maxWidth: 480, margin: '24px auto', borderRadius: 12, position: 'relative', minHeight: 'calc(100% - 48px)' }}>
            <button
              onClick={() => setShowPayment(false)}
              style={{ position: 'absolute', top: 12, right: 12, fontSize: 20, background: 'none', border: 'none', cursor: 'pointer', color: '#6b6b68', lineHeight: 1, zIndex: 1 }}
              aria-label="Close"
            >
              ✕
            </button>
            <PaymentScreen
              user={user}
              onPaymentDone={() => {
                setHasAccess(true);
                setShowPayment(false);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
