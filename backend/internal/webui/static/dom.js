/**
 * A tiny safe DOM builder, shared by every view.
 *
 * Every dynamic value the dashboard renders (a page path, a referrer host, a
 * CSS selector recorded by the tracker, a username) is untrusted text. This
 * never touches innerHTML with it: text children always become Text nodes,
 * never parsed as markup, so there is no escaping function to forget and
 * nothing rendered here can execute as HTML.
 */

/** @typedef {Record<string, string | boolean | ((event: Event) => void) | null | undefined>} ElAttrs */
/** @typedef {ElChildLeaf | ElChildLeaf[]} ElChild */
/** @typedef {Node | string | number | boolean | null | undefined} ElChildLeaf */

/**
 * el('div', {class: 'foo', onclick: fn}, child1, child2, ...)
 *
 * Attribute values of `null`/`undefined` are skipped. A key starting with
 * "on" whose value is a function is wired as an event listener instead of an
 * attribute (`onclick` -> a real `click` listener, not an onclick="" string).
 * @param {string} tag
 * @param {ElAttrs | null} [attrs]
 * @param {...ElChild} children
 * @returns {HTMLElement}
 */
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag)
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const value = attrs[key]
      if (value === null || value === undefined) continue
      if (key === 'class') node.className = String(value)
      else if (key === 'for') node.setAttribute('for', String(value))
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2), value)
      } else if (typeof value === 'boolean') {
        if (value) node.setAttribute(key, '')
      } else {
        node.setAttribute(key, String(value))
      }
    }
  }
  for (const child of children) append(node, child)
  return node
}

/** @typedef {Record<string, string | number | null | undefined>} SvgAttrs */

/**
 * svgEl builds an element in the SVG namespace — el() cannot, since
 * document.createElement always makes an (X)HTML element.
 *
 * Attribute values may be numbers as well as strings — SVG geometry
 * attributes (x1, y1, r, ...) are routinely set that way, and
 * setAttribute() coerces exactly like the DOM does natively.
 * @param {string} tag
 * @param {SvgAttrs | null} [attrs]
 * @param {...ElChild} children
 * @returns {SVGElement}
 */
export function svgEl(tag, attrs, ...children) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const value = attrs[key]
      if (value === null || value === undefined) continue
      node.setAttribute(key, String(value))
    }
  }
  for (const child of children) append(node, child)
  return node
}

/**
 * @param {Node} node
 * @param {ElChild} child
 */
export function append(node, child) {
  if (child === null || child === undefined || child === false) return
  if (Array.isArray(child)) {
    for (const c of child) append(node, c)
    return
  }
  // `instanceof Node` (rather than the previous `.nodeType` cast-and-check)
  // is a real type guard, so TS narrows `child` to Node in the true branch
  // and to the remaining string | number | boolean leaf types in the false
  // branch — the latter is what makes String(child) provably safe instead
  // of merely assumed safe.
  node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)))
}

/** @param {Node} node */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

/**
 * @param {Node} node
 * @param {...ElChild} children
 */
export function replace(node, ...children) {
  clear(node)
  for (const c of children) append(node, c)
}
