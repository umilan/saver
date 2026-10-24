// Injected into a shop page by the popup's target buttons (after extractor.js). Outlines
// whatever is under the pointer; a click on the price, or on the product name, reports where
// it is (a CSS selector) to the background worker, which remembers it for this shop. Which
// of the two is picked comes in __shopMarksPickKind (page.js). Esc cancels.
(() => {
  if (globalThis.__shopMarksPicker) return;
  globalThis.__shopMarksPicker = true;
  const kind = globalThis.__shopMarksPickKind === 'title' ? 'title' : 'price';
  const WHAT = kind === 'title' ? 'product name' : 'price';

  const ACCENT = 'rgb(25, 100, 50)';
  const box = document.createElement('div');
  const banner = document.createElement('div');
  Object.assign(box.style, {
    position: 'fixed',
    zIndex: 2147483647,
    pointerEvents: 'none',
    border: `2px solid ${ACCENT}`,
    borderRadius: '4px',
    background: 'rgba(25, 100, 50, 0.1)',
    transition: 'all 0.05s',
    display: 'none',
  });
  Object.assign(banner.style, {
    position: 'fixed',
    zIndex: 2147483647,
    top: '16px',
    left: '50%',
    translate: '-50% 0',
    padding: '8px 16px',
    borderRadius: '8px',
    background: ACCENT,
    color: '#fff',
    font: '600 14px/1.4 system-ui, sans-serif',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
    pointerEvents: 'none',
  });
  banner.textContent = `ShopMarx: click the ${WHAT} (Esc to cancel)`;
  document.documentElement.append(box, banner);

  let target = null;

  function onMove(event) {
    const el = document.elementFromPoint(event.clientX, event.clientY);
    if (!el || el === target) return;
    target = el;
    const rect = el.getBoundingClientRect();
    Object.assign(box.style, {
      display: 'block',
      top: `${rect.top - 2}px`,
      left: `${rect.left - 2}px`,
      width: `${rect.width + 4}px`,
      height: `${rect.height + 4}px`,
    });
    const value = valueOf(el);
    banner.textContent = value == null
      ? `ShopMarx: no ${WHAT} here, keep looking (Esc to cancel)`
      : `ShopMarx: click to use ${value.slice(0, 40)}`;
  }

  // The text the element would give: a price, or a product name (any short text). Null when
  // the element does not hold one.
  function valueOf(el) {
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    if (kind === 'title') return text && text.length <= 300 ? text : null;
    return globalThis.SaverExtract.parsePrice(el.textContent) == null ? null : text;
  }

  function onClick(event) {
    // The click is ours: the page must not follow a link or add to cart.
    event.preventDefault();
    event.stopPropagation();
    const el = target;
    if (!el || valueOf(el) == null) return;
    const selector = selectorFor(el);
    stop();
    banner.textContent = selector
      ? `ShopMarx: ${WHAT} spot saved. Open ShopMarx again to finish.`
      : `ShopMarx: could not remember that spot. Try clicking the ${kind === 'title' ? 'name' : 'number'} itself.`;
    document.documentElement.append(banner);
    setTimeout(() => banner.remove(), 4000);
    if (!selector) return;
    if (kind === 'title') chrome.runtime.sendMessage({ type: 'title-spot', url: location.href, spot: { selector } });
    else chrome.runtime.sendMessage({ type: 'price-spot', url: location.href, spot: { selector, label: labelFor(el) } });
  }

  function onKey(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    stop();
  }

  function stop() {
    removeEventListener('mousemove', onMove, true);
    removeEventListener('click', onClick, true);
    removeEventListener('keydown', onKey, true);
    box.remove();
    banner.remove();
    globalThis.__shopMarksPicker = false;
  }

  // A short text label just before the price ("Cena:", "Price"), as in shops that lay out
  // details as label / value rows. Found on the element or an ancestor's previous sibling.
  function labelFor(el) {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      const text = node.previousElementSibling?.textContent.replace(/\s+/g, ' ').trim();
      if (text && text.length <= 30 && /\p{L}/u.test(text) && globalThis.SaverExtract.parsePrice(text) == null) return text;
    }
    return null;
  }

  // A selector that finds this element again on other product pages of the shop:
  // the nearest id, then tag and stable-looking classes, with a position only when needed.
  function selectorFor(el) {
    const parts = [];
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      if (node.id && !/\d{3,}/.test(node.id)) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      let part = node.localName;
      const classes = [...node.classList].filter((name) => !/\d{3,}|active|hover|selected|open/i.test(name)).slice(0, 2);
      if (classes.length) part += classes.map((name) => `.${CSS.escape(name)}`).join('');
      const siblings = node.parentElement ? [...node.parentElement.children].filter((child) => child.matches(part)) : [];
      if (siblings.length > 1) part += `:nth-of-type(${[...node.parentElement.children].filter((child) => child.localName === node.localName).indexOf(node) + 1})`;
      parts.unshift(part);
      if (document.querySelector(parts.join(' > ')) === el) break;
    }
    const selector = parts.join(' > ');
    return document.querySelector(selector) === el ? selector : null;
  }

  addEventListener('mousemove', onMove, true);
  addEventListener('click', onClick, true);
  addEventListener('keydown', onKey, true);
})();
