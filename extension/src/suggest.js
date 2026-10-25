// Suggestions for the search box (search.js has the syntax): while typing a part of the
// search, a list under the box offers ways to finish it. `[gi` offers [Gift ideas],
// `shop:ik` offers shop:ikea.com, `has:` the flags, `pr` the price forms; a plain word offers
// the lists and shops whose names have it, as [name]. Up and down choose, Enter or Tab puts
// the choice in (a plain word's offers wait for up or down first, so Enter keeps the word),
// Escape closes the list.
//
// attachSuggest(input, list, places): `list` is the element to fill; places() gives the
// lists and shops as { name, kind, detail } at the time of typing.

const LIMIT = 8;
const FLAGS = [
  ['note', 'items with a note'],
  ['price', 'items with a price'],
  ['picture', 'items with a picture'],
  ['list', 'items in a list'],
];
const COMMANDS = [
  { text: '[', show: '[list]', detail: 'items in a list or shop', open: true },
  { text: 'shop:', show: 'shop:', detail: 'items from a shop', open: true },
  { text: 'price<', show: 'price<50', detail: 'cheaper than', open: true },
  { text: 'price>', show: 'price>20', detail: 'dearer than', open: true },
  { text: 'price:', show: 'price:20-50', detail: 'between two prices', open: true },
  { text: 'has:', show: 'has:', detail: 'note, price, picture, list', open: true },
  { text: 'no:', show: 'no:', detail: 'without a note, price, picture or list', open: true },
  { text: 'is:cheaper ', show: 'is:cheaper', detail: 'price went down since saved' },
  { text: 'is:pricier ', show: 'is:pricier', detail: 'price went up since saved' },
];

export function attachSuggest(input, list, places) {
  let items = [];
  let active = -1;
  let token = null;
  list.id ||= 'search-suggest';
  list.setAttribute('role', 'listbox');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');

  const close = () => {
    items = [];
    active = -1;
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };

  const show = () => {
    token = currentToken(input);
    const found = token ? offers(token, places()) : { items: [], ready: false };
    items = found.items.slice(0, LIMIT);
    active = found.ready && items.length ? 0 : -1;
    if (!items.length) return close();
    draw();
  };

  const draw = () => {
    list.replaceChildren(
      ...items.map((item, index) => {
        const row = document.createElement('div');
        row.className = `suggest__item${index === active ? ' suggest__item--active' : ''}`;
        row.id = `${list.id}-${index}`;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(index === active));
        const label = document.createElement('span');
        label.className = 'suggest__label';
        // A list or shop looks as it will in the box: a tag.
        const tag = item.show.match(/^(-?\[)(.*)(\])$/);
        if (tag) {
          const inner = document.createElement('span');
          inner.className = `list-choice__chip suggest__chip${tag[1].startsWith('-') ? ' search-tag--not' : ''}`;
          inner.append(Object.assign(document.createElement('span'), { className: 'list-choice__chip-name', textContent: tag[2] }));
          label.append(inner);
        } else {
          label.textContent = item.show;
        }
        const detail = document.createElement('span');
        detail.className = 'suggest__detail';
        detail.textContent = item.detail ?? '';
        row.append(label, detail);
        row.addEventListener('pointerdown', (event) => event.preventDefault());
        row.addEventListener('click', () => accept(index));
        return row;
      }),
    );
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (active >= 0) input.setAttribute('aria-activedescendant', `${list.id}-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };

  // Puts the choice in place of the part being typed (and a ] or the rest of the part right
  // after the caret), then offers what can follow it.
  const accept = (index) => {
    const item = items[index];
    if (!item || !token) return;
    const value = input.value;
    const rest = value.slice(token.end).match(/^[^\s]*/)[0];
    const after = value.slice(token.end + rest.length).replace(/^ /, '');
    const text = item.text;
    input.value = value.slice(0, token.start) + text + after;
    const caret = token.start + text.length;
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (item.open) show();
    else close();
  };

  input.addEventListener('input', show);
  input.addEventListener('focus', show);
  input.addEventListener('blur', close);
  input.addEventListener('click', show);
  // Before the box's other keys (capture): while the list is open, these are its keys.
  input.addEventListener(
    'keydown',
    (event) => {
      if (list.hidden || event.altKey || event.metaKey || event.ctrlKey) return;
      const handled = () => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        // Up from the first offer goes back to the plain text; down past the last ends there.
        const step = event.key === 'ArrowDown' ? 1 : -1;
        if (step > 0 && active === items.length - 1) return;
        if (step < 0 && active < 0) return;
        handled();
        active += step;
        return draw();
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && active >= 0 && !event.shiftKey) {
        handled();
        return accept(active);
      }
      if (event.key === 'Escape') {
        handled();
        return close();
      }
    },
    true,
  );
  return { close };
}

// The part of the search the caret is in: an open [list (spaces allowed), or a word.
function currentToken(input) {
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  const open = before.match(/(-?)\[([^\]]*)$/);
  if (open) return { kind: 'list', start: open.index, end: caret, not: open[1], query: open[2].toLowerCase() };
  const word = before.match(/(-?)(\S*)$/);
  if (!word[0]) return null;
  return { kind: 'word', start: word.index, end: caret, not: word[1], query: word[2].toLowerCase() };
}

const SPECIAL = [
  { name: 'all', kind: 'every item' },
  { name: 'unsorted', kind: 'items in no list' },
];

// What to offer for a part: { items: [{ text, show, detail, open? }], ready } — ready when
// Enter may take the first offer right away (the part is clearly being completed).
function offers(token, places) {
  const { query, not } = token;
  const rank = (name) => (name.toLowerCase().startsWith(query) ? 0 : 1);
  const byRank = (a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name);
  if (token.kind === 'list') {
    const items = [...SPECIAL.map((s) => ({ name: s.name, detail: s.kind })), ...places.map((p) => ({ name: p.name, detail: p.detail }))]
      .filter((p) => p.name.toLowerCase().includes(query))
      .sort(byRank)
      .map((p) => ({ text: `${not}[${p.name}] `, show: `${not}[${p.name}]`, detail: p.detail }));
    return { items, ready: true };
  }
  let match;
  if ((match = query.match(/^shop:(.*)$/))) {
    const items = places
      .filter((p) => p.kind === 'shop' && p.name.toLowerCase().includes(match[1]))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ text: `${not}shop:${p.name} `, show: `${not}shop:${p.name}`, detail: p.detail }));
    return { items, ready: true };
  }
  if ((match = query.match(/^(has|no):(\w*)$/))) {
    const items = FLAGS.filter(([flag]) => flag.startsWith(match[2])).map(([flag, detail]) => ({
      text: `${not}${match[1]}:${flag} `,
      show: `${match[1]}:${flag}`,
      detail: match[1] === 'no' ? detail.replace('items with', 'items without').replace('items in a', 'items in no') : detail,
    }));
    return { items, ready: true };
  }
  if ((match = query.match(/^is:(\w*)$/))) {
    const items = COMMANDS.filter((c) => c.text.startsWith(`is:${match[1]}`)).map((c) => ({ ...c, text: not + c.text }));
    return { items, ready: true };
  }
  if (query.includes(':') || /^price[<>:]/.test(query)) return { items: [], ready: false };
  // A plain word: the commands it starts, then the lists and shops with it in their names.
  const commands = query ? COMMANDS.filter((c) => c.text.startsWith(query) && c.text !== '[').map((c) => ({ ...c, text: not + c.text })) : [];
  const lists = query.length >= 2
    ? places
        .filter((p) => p.name.toLowerCase().includes(query))
        .sort(byRank)
        .map((p) => ({ text: `${not}[${p.name}] `, show: `${not}[${p.name}]`, detail: p.detail }))
    : [];
  return { items: [...commands, ...lists], ready: false };
}
