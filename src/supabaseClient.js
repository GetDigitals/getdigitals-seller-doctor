// supabaseClient.js
// Central place that creates the Supabase connection. Every other file
// (Auth, Dashboard, Listing Generator) imports `supabase` from here —
// never create a second client elsewhere in the app.

import { createClient } from '@supabase/supabase-js';

// These two values come from: Supabase Dashboard → Project Settings → API
// SUPABASE_URL and SUPABASE_ANON_KEY are both safe to expose in frontend
// code (the "anon" key only allows what our Row Level Security policies
// permit — it can NEVER read another user's data, even if someone finds
// it in the browser's network tab).
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
