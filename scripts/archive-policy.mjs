const directoryListing = /<title\b[^>]*>\s*index of\b|<h1\b[^>]*>\s*index of\b/i;
const unsafeLegacyJavaScript = /javascript:|\beval\(|document\.(?:all|layers)/i;
const nonIndexableRoute = /(?:^|\/)(?:_?bak|icons|downloads?|img)(?:\/|$)|(?:legacy-services|archive-unavailable|form_response|contact_form)\.html$/i;

export const isDirectoryListing = (html) => directoryListing.test(html);
export const hasUnsafeLegacyJavaScript = (html) => unsafeLegacyJavaScript.test(html);
export const isNoIndexRoute = (relativePath) => nonIndexableRoute.test(relativePath.replaceAll('\\', '/'));

export const sanitizeUnsafeLegacyJavaScript = (html) => html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (script) => hasUnsafeLegacyJavaScript(script) ? '' : script)
  .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  .replace(/\bhref\s*=\s*(["'])javascript:[\s\S]*?\1/gi, 'href="#"');

export const isCriticalImage = (relativePage, tag) => relativePage === 'index.html' && /\bid="home-(?:top-left|portal|logo|bottom-left)"/i.test(tag);
