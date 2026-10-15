// ============================================================================
//  HTML-safe output helpers for every page generator.
//
//  jsonForScript(v) — JSON for embedding INSIDE a <script> element (incl. type="application/ld+json"
//    and inline `var X = …;` data). Plain JSON.stringify is NOT safe there: a string containing
//    "</script>" or "<!--" ends/derails the script block and whatever follows is parsed as HTML (XSS).
//    Escaping < > & U+2028 U+2029 as \uXXXX keeps the value byte-for-byte identical after JSON/JS
//    parsing while making the markup inert. (Those chars only ever occur inside JSON strings, so the
//    \u escapes are always valid.)
//  escHtml(s) — text/attribute escaping (& < > " ' `).
//
//  When the result is spliced in with String.prototype.replace, ALWAYS pass a function
//  (`tpl.replace(PH, () => jsonForScript(x))`): a string replacement interprets `$'`, `$&`, `` $` ``
//  inside the data, which lets a name like "$'<img onerror=…>" re-inject template text.
//  seo-nft.mjs keeps an identical inline copy (it must stay import-clean for the Netlify bundle).
// ============================================================================
export function jsonForScript(v) {
  const s = JSON.stringify(v);
  return (s === undefined ? "null" : s).replace(/[<>&\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}
export function escHtml(s) {
  return String(s ?? "").replace(/[&<>"'`]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" }[c]));
}
