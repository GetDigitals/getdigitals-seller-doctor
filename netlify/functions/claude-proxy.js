// netlify/functions/claude-proxy.js
// The browser can never hold an Anthropic API key safely, so every AI
// call from the app (SellerDoctorTool.jsx) goes through this function
// instead of hitting api.anthropic.com directly. The real key lives only
// in Netlify's environment variables, never in any file the browser sees.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { model, max_tokens, messages } = JSON.parse(event.body);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model || 'claude-sonnet-4-6',
        max_tokens: max_tokens || 1200,
        messages,
      }),
    });

    const data = await response.json();
    return {
      statusCode: response.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: { message: 'Proxy error: ' + err.message } }),
    };
  }
};
