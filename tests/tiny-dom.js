/* A 60-line stand-in for the DOM, enough to run htmlToMd() under node.

   The editor's serializer walks childNodes / tagName / textContent / getAttribute
   (and its click handling walks parentNode), so a real browser is not needed to
   test them — only well-formed HTML, which is exactly what mdToHtml() produces.
   Void elements are the ones that HTML says never have a closing tag. */
'use strict';

const VOID = new Set(['BR', 'HR', 'IMG', 'INPUT', 'META', 'LINK']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
const decode = s => s.replace(/&(#?\w+);/g, (m, e) => (e in ENTITIES ? ENTITIES[e] : m));

function element(tagName, attrs) {
  const el = {
    nodeType: 1,
    tagName,
    attrs,
    childNodes: [],
    getAttribute: name => (name in attrs ? attrs[name] : null),
    get checked() { return 'checked' in attrs; },
    get textContent() { return el.childNodes.map(c => c.textContent).join(''); },
  };
  return el;
}
const textNode = data => ({ nodeType: 3, textContent: data, childNodes: [] });
const append = (parent, child) => { child.parentNode = parent; parent.childNodes.push(child); };

function parseHtml(html) {
  const root = element('DIV', {});
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const re = /<\/?([a-zA-Z][\w-]*)((?:\s+[\w-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g;
  let at = 0, m;
  while ((m = re.exec(html))) {
    if (m.index > at) append(top(), textNode(decode(html.slice(at, m.index))));
    at = m.index + m[0].length;
    const tag = m[1].toUpperCase();
    if (m[0][1] === '/') {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tagName === tag) { stack.length = i; break; }
      continue;
    }
    const attrs = {};
    const ar = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let a;
    while ((a = ar.exec(m[2]))) attrs[a[1]] = decode(a[2] ?? a[3] ?? a[4] ?? '');
    const el = element(tag, attrs);
    append(top(), el);
    if (!VOID.has(tag)) stack.push(el);
  }
  if (at < html.length) append(top(), textNode(decode(html.slice(at))));
  return root;
}

module.exports = { parseHtml };
