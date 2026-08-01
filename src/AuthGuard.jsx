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

export default function AuthGuard({ children }) {
  const [user, setUser] = useState(null);
  const [hasAccess, setHasAccess] = useState(null); // null = still checking
  const [checking, setChecking] = useState(true);

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
    // Ask the database (via the helper function from the SQL schema)
    // whether this specific user currently has an active, unexpired plan.
    supabase.rpc('has_active_subscription', { check_user_id: user.id }).then(({ data }) => {
      setHasAccess(!!data);
    });
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

  if (!hasAccess) {
    return <PaymentScreen user={user} onPaymentDone={() => setHasAccess(true)} />;
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 16px', borderBottom: '1px solid #e5e4df', fontFamily: 'system-ui, sans-serif' }}>
        <span style={{ fontSize: 12, color: '#9a9a95', marginRight: 12, alignSelf: 'center' }}>{user.email}</span>
        <button
          onClick={() => supabase.auth.signOut()}
          style={{ fontSize: 12, color: '#6b6b68', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
        >
          Logout
        </button>
      </div>
      {children}
    </div>
  );
}
