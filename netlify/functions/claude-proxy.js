// netlify/functions/claude-proxy.js
// The browser can never hold an API key safely, so every AI call from the
// app (SellerDoctorTool.jsx) goes through this function instead of hitting
// the provider directly. The real key lives only in Netlify's environment
// variables, never in any file the browser sees.
//
// NOTE: this calls Google's Gemini API (free tier), not Anthropic — but it
// converts the request/response so the frontend, which was written against
// Anthropic's Messages API shape, doesn't need to change at all.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { max_tokens, messages } = JSON.parse(event.body);

    // Gemini's current stable Flash model (as of Aug 2026). gemini-2.5-flash
    // was retired for new API keys — update this string if Google ships a
    // newer stable model later and this one gets deprecated too.
    const GEMINI_MODEL = 'gemini-3.6-flash';

    // Convert Anthropic-style messages ([{role, content}]) into Gemini's
    // "contents" format ([{role, parts: [{text}]}]). Gemini uses "model"
    // instead of "assistant" for the role name.
    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
    }));

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        generationConfig: {
          maxOutputTokens: max_tokens || 1200,
        },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      // Bubble up Gemini's error but in the shape the frontend expects:
      // errBody?.error?.message
      return {
        statusCode: response.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: { message: data?.error?.message || 'Gemini API error' } }),
      };
    }

    // Pull the text out of Gemini's response shape and repackage it into
    // Anthropic's shape: { content: [{ type: "text", text: "..." }] }
    const text =
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'text', text }] }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: { message: 'Proxy error: ' + err.message } }),
    };
  }
};
