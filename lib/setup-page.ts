/**
 * Minimal HTML responses for the two OAuth setup routes.
 *
 * These are operator-facing pages outside the chat UI, so they are plain HTML
 * rather than React. Nothing rendered here ever includes token material.
 */

import 'server-only';

export interface SetupPageOptions {
  status: number;
  heading: string;
  body: string;
  tone: 'success' | 'error';
  /** Optional extra lines rendered as a list below the body. */
  details?: string[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderSetupPage({ status, heading, body, tone, details }: SetupPageOptions): Response {
  const accent = tone === 'success' ? '#0b7a3b' : '#b3261e';
  const items = (details ?? []).map((line) => `<li>${escapeHtml(line)}</li>`).join('');

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${escapeHtml(heading)}</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f6f9;
             font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #181818; }
      main { max-width: 34rem; padding: 2.5rem; background: #fff; border-radius: 1rem;
             box-shadow: 0 10px 40px rgba(16, 24, 40, 0.08); }
      h1 { margin: 0 0 0.75rem; font-size: 1.35rem; color: ${accent}; }
      p { margin: 0 0 1rem; line-height: 1.6; }
      ul { margin: 0 0 1rem; padding-left: 1.2rem; line-height: 1.6; }
      a { color: #0176d3; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(heading)}</h1>
      <p>${escapeHtml(body)}</p>
      ${items ? `<ul>${items}</ul>` : ''}
      <p><a href="/">Open the assistant</a></p>
    </main>
  </body>
</html>`;

  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
