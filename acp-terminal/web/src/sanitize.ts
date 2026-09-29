// Allowlist sanitizer for HTML rendered from agent-produced markdown.
// Agent output can echo text from untrusted repo files, so anything that
// could run script (tags, on* handlers, javascript: URLs) is dropped before
// it reaches dangerouslySetInnerHTML.

const ALLOWED_TAGS = new Set([
  'a', 'b', 'blockquote', 'br', 'code', 'del', 'details', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'img', 'input', 'kbd', 'li', 'ol', 'p', 'pre', 's', 'span', 'strong', 'sub', 'summary',
  'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
]);

// Elements whose content must be discarded entirely rather than unwrapped.
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'svg', 'math']);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
  code: new Set(['class']),
  span: new Set(['class']),
  ol: new Set(['start']),
  td: new Set(['align', 'colspan', 'rowspan']),
  th: new Set(['align', 'colspan', 'rowspan']),
  input: new Set(['type', 'checked', 'disabled']),
};

function isSafeUrl(value: string, tag: string): boolean {
  const v = value.trim().toLowerCase();
  if (v.startsWith('#') || v.startsWith('/') || v.startsWith('./') || v.startsWith('../')) return true;
  if (v.startsWith('http://') || v.startsWith('https://') || v.startsWith('mailto:')) return true;
  if (tag === 'img' && /^data:image\/(png|jpe?g|gif|webp);/.test(v)) return true;
  // Relative paths without a scheme are fine; anything with a scheme we didn't list is not.
  return !/^[a-z][a-z0-9+.-]*:/.test(v);
}

function clean(node: Node): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.COMMENT_NODE) {
      child.remove();
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const el = child as Element;
    const tag = el.tagName.toLowerCase();

    if (DROP_WITH_CONTENT.has(tag)) {
      el.remove();
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) {
      // Unwrap: keep the (cleaned) children, drop the element itself.
      clean(el);
      el.replaceWith(...Array.from(el.childNodes));
      continue;
    }

    const allowed = ALLOWED_ATTRS[tag];
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (!allowed || !allowed.has(name)) {
        el.removeAttribute(attr.name);
      } else if ((name === 'href' || name === 'src') && !isSafeUrl(attr.value, tag)) {
        el.removeAttribute(attr.name);
      }
    }
    if (tag === 'input' && el.getAttribute('type') !== 'checkbox') {
      el.remove();
      continue;
    }
    clean(el);
  }
}

export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  clean(doc.body);
  return doc.body.innerHTML;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
