/**
 * A tiny safe DOM builder, shared by every view.
 *
 * Every dynamic value the dashboard renders (a page path, a referrer host, a
 * CSS selector recorded by the tracker, a username) is untrusted text. This
 * never touches innerHTML with it: text children always become Text nodes,
 * never parsed as markup, so there is no escaping function to forget and
 * nothing rendered here can execute as HTML.
 */

/**
 * el('div', {class: 'foo', onclick: fn}, child1, child2, ...)
 *
 * Attribute values of `null`/`undefined` are skipped. A key starting with
 * "on" whose value is a function is wired as an event listener instead of an
 * attribute (`onclick` -> a real `click` listener, not an onclick="" string).
 */
export function el(tag, attrs) {
  const node = document.createElement(tag)
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const value = attrs[key]
      if (value === null || value === undefined) continue
      if (key === 'class') node.className = value
      else if (key === 'for') node.setAttribute('for', value)
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2), value)
      } else if (typeof value === 'boolean') {
        if (value) node.setAttribute(key, '')
      } else {
        node.setAttribute(key, value)
      }
    }
  }
  for (let i = 2; i < arguments.length; i++) append(node, arguments[i])
  return node
}

/** svgEl builds an element in the SVG namespace — el() cannot, since
 * document.createElement always makes an (X)HTML element. */
export function svgEl(tag, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const value = attrs[key]
      if (value === null || value === undefined) continue
      node.setAttribute(key, value)
    }
  }
  for (let i = 2; i < arguments.length; i++) append(node, arguments[i])
  return node
}

export function append(node, child) {
  if (child === null || child === undefined || child === false) return
  if (Array.isArray(child)) {
    for (const c of child) append(node, c)
    return
  }
  node.appendChild(child.nodeType ? child : document.createTextNode(String(child)))
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

export function replace(node, ...children) {
  clear(node)
  for (const c of children) append(node, c)
}
