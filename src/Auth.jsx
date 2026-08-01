// Auth.jsx
// Login + Signup screen. Email/password to start (fastest to ship) —
// phone/OTP can be added later as an upgrade once an SMS provider
// (e.g. MSG91, Twilio) is connected in Supabase Auth settings.

import React, { useState } from 'react';
import { supabase } from './supabaseClient';

export default function Auth({ onLoggedIn }) {
  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('idle'); // idle | loading | check-email

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setStatus('loading');

    if (mode === 'signup') {
      const { data, error: signupError } = await supabase.auth.signUp({
        email,
        password,
      });
      if (signupError) {
        setError(signupError.message);
        setStatus('idle');
        return;
      }
      // Store the extra profile info (business name, phone) once the
      // user exists. If email confirmation is ON in Supabase settings,
      // data.user exists immediately but data.session is null until
      // they click the confirmation link — handle both cases.
      if (data.user) {
        await supabase.from('profiles').insert({
          id: data.user.id,
          business_name: businessName,
          phone,
        });
      }
      if (!data.session) {
        setStatus('check-email');
        return;
      }
      onLoggedIn(data.session.user);
      return;
    }

    // mode === 'login'
    const { data, error: loginError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (loginError) {
      setError(loginError.message);
      setStatus('idle');
      return;
    }
    onLoggedIn(data.user);
  };

  if (status === 'check-email') {
    return (
      <div style={{ maxWidth: 400, margin: '60px auto', textAlign: 'center', fontFamily: 'system-ui, sans-serif' }}>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>Email check karo</h2>
        <p style={{ color: '#6b6b68', fontSize: 14 }}>
          Humne {email} pe ek confirmation link bheja hai. Link pe click karke apna account activate karo, phir yahan wapas aake login karo.
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 400, margin: '60px auto', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ width: 56, height: 56, borderRadius: 14, background: '#0F6E56', margin: '0 auto 20px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#E1F5EE', fontSize: 24, fontWeight: 600 }}>AI</div>
      <p style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.06em', color: '#0F6E56', textTransform: 'uppercase', textAlign: 'center', margin: '0 0 20px' }}>GetDigitals Seller Doctor</p>

      <div style={{ display: 'flex', marginBottom: 24, border: '1px solid #e5e4df', borderRadius: 8, overflow: 'hidden' }}>
        <button
          onClick={() => setMode('login')}
          style={{ flex: 1, padding: 10, border: 'none', background: mode === 'login' ? '#0F6E56' : '#fff', color: mode === 'login' ? '#fff' : '#1a1a1a', fontWeight: 500, cursor: 'pointer' }}
        >
          Login
        </button>
        <button
          onClick={() => setMode('signup')}
          style={{ flex: 1, padding: 10, border: 'none', background: mode === 'signup' ? '#0F6E56' : '#fff', color: mode === 'signup' ? '#fff' : '#1a1a1a', fontWeight: 500, cursor: 'pointer' }}
        >
          Sign Up
        </button>
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {mode === 'signup' && (
          <>
            <input
              placeholder="Business Name"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              style={{ padding: 10, borderRadius: 8, border: '1px solid #e5e4df', fontSize: 14 }}
            />
            <input
              placeholder="Phone Number"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              style={{ padding: 10, borderRadius: 8, border: '1px solid #e5e4df', fontSize: 14 }}
            />
          </>
        )}
        <input
          type="email"
          placeholder="Email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ padding: 10, borderRadius: 8, border: '1px solid #e5e4df', fontSize: 14 }}
        />
        <input
          type="password"
          placeholder="Password (kam se kam 6 characters)"
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ padding: 10, borderRadius: 8, border: '1px solid #e5e4df', fontSize: 14 }}
        />
        {error && <p style={{ color: '#A32D2D', fontSize: 13, margin: 0 }}>{error}</p>}
        <button
          type="submit"
          disabled={status === 'loading'}
          style={{ background: '#0F6E56', color: '#fff', border: 'none', padding: 12, borderRadius: 8, fontSize: 15, fontWeight: 500, cursor: 'pointer', opacity: status === 'loading' ? 0.6 : 1 }}
        >
          {status === 'loading' ? 'Please wait...' : mode === 'login' ? 'Login' : 'Account banao'}
        </button>
      </form>
    </div>
  );
}
