// Picks any number of lists for an item: a field with the chosen lists as chips and a box
// to type in. Typing filters the lists below it; a name that matches none can be made a new
// list. Used by the popup and the dashboard's edit and add dialogs.
//
// Keys in the box: up/down move through the lists, Enter ticks or unticks the highlighted
// one, Backspace on an empty box removes the last chip, Escape closes the lists. A comma ends
// a name, so "home, tech" (typed or pasted) picks both lists, making the ones that do not
// exist yet.
//
// Markup (see popup.html):
//   <div class="list-choice">
//     <div class="input list-choice__field">
//       <input class="list-choice__search" maxlength="60" autocomplete="off" aria-label="Lists">
//     </div>
//     <div class="list-choice__panel" hidden></div>
//   </div>

import { NO_LIST_NAME, createList, listTree } from './store.js';

const states = new WeakMap();
let nextId = 0;

// The lists close on any press outside their picker, so only one is open at a time.
document.addEventListener('pointerdown', (event) => {
  for (const root of document.querySelectorAll('.list-choice[data-open]')) {
    if (!root.contains(event.target)) setOpen(root, false);
  }
});

// Fills the choice with the lists, the selected ones as chips. emptyLabel names the
// "no list" state, e.g. "Unsorted". With lastUsed, the selection is the one used last time
// and the field says so until it is changed.
export function fillListChoice(root, lists, selected, emptyLabel, { lastUsed = false } = {}) {
  if (!states.has(root)) setUp(root);
  const state = states.get(root);
  const known = new Set(lists.map((list) => list.id));
  Object.assign(state, {
    lists,
    selected: new Set(selected.filter((id) => known.has(id))),
    created: [],
    emptyLabel,
    lastUsed: lastUsed ? key(selected) : null,
    active: 0,
  });
  state.search.value = '';
  setOpen(root, false);
  render(root);
}

// The chosen list ids. Names added as new lists become lists first.
export async function chosenLists(root) {
  const { selected, created } = states.get(root);
  const ids = [...selected];
  for (const name of created) ids.push((await createList(name)).id);
  return ids;
}

function key(ids) {
  return [...ids].sort().join();
}

function setUp(root) {
  const search = root.querySelector('.list-choice__search');
  const panel = root.querySelector('.list-choice__panel');
  const field = root.querySelector('.list-choice__field');
  panel.id ||= `list-choice-${nextId++}`;
  panel.setAttribute('role', 'listbox');
  panel.setAttribute('aria-multiselectable', 'true');
  search.setAttribute('role', 'combobox');
  search.setAttribute('aria-autocomplete', 'list');
  search.setAttribute('aria-controls', panel.id);
  states.set(root, { search, panel, field });

  // A press anywhere on the field types into the box and shows the lists.
  field.addEventListener('pointerdown', (event) => {
    if (event.target !== search) event.preventDefault();
    if (event.target.closest('.list-choice__chip-remove')) return;
    search.focus();
    setOpen(root, !('open' in root.dataset) || event.target === search);
  });
  field.addEventListener('click', (event) => {
    const remove = event.target.closest('.list-choice__chip-remove');
    if (!remove) return;
    unchoose(root, remove.dataset.id, remove.dataset.name);
    search.focus();
  });

  // Presses on the lists keep the focus in the box.
  panel.addEventListener('pointerdown', (event) => event.preventDefault());
  panel.addEventListener('click', (event) => {
    const option = event.target.closest('.list-choice__option');
    if (option) pick(root, Number(option.dataset.index));
  });

  search.addEventListener('input', () => {
    states.get(root).active = 0;
    if (search.value.includes(',')) takeNames(root);
    setOpen(root, true);
  });
  search.addEventListener('focus', () => render(root));
  search.addEventListener('blur', () => {
    setOpen(root, false);
    render(root);
  });
  search.addEventListener('keydown', (event) => onKey(root, event));
}

function onKey(root, event) {
  const state = states.get(root);
  const open = 'open' in root.dataset;
  const items = open ? options(state) : [];
  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      event.preventDefault();
      if (!open) return setOpen(root, true);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      state.active = (state.active + step + items.length) % Math.max(items.length, 1);
      return render(root);
    }
    case 'Enter':
      // Cmd/Ctrl+Enter is left for the page: it saves.
      if (event.metaKey || event.ctrlKey) return;
      // Never sends the form from here while there is something to pick.
      if (open && items[state.active]) {
        event.preventDefault();
        pick(root, state.active);
      } else if (state.search.value.trim()) {
        event.preventDefault();
      }
      return;
    case 'Escape':
      // Closes the lists, not the dialog or popup around them.
      if (!open) return;
      event.preventDefault();
      event.stopPropagation();
      return setOpen(root, false);
    case 'Backspace':
      if (state.search.value) return;
      event.preventDefault();
      if (state.created.length) return unchoose(root, null, state.created.at(-1));
      if (state.selected.size) return unchoose(root, [...state.selected].at(-1));
      return;
    case 'Tab':
      return setOpen(root, false);
  }
}

// What the lists show for the typed text: matching lists (in tree order, sub-lists indented
// while nothing is typed), then a row to make the text a new list when no list has that name.
function options(state) {
  const query = state.search.value.trim();
  const lower = query.toLowerCase();
  const items = listTree(state.lists)
    .filter(({ list }) => list.name.toLowerCase().includes(lower))
    .map(({ list, depth }) => ({ id: list.id, name: list.name, depth: query ? 0 : depth }));
  const taken = [...state.lists.map((list) => list.name), ...state.created].some((name) => name.toLowerCase() === lower);
  if (query && !taken) items.push({ create: true, name: query });
  return items;
}

function pick(root, index) {
  const state = states.get(root);
  const item = options(state)[index];
  if (!item) return;
  if (item.create) state.created.push(item.name);
  else if (state.selected.has(item.id)) state.selected.delete(item.id);
  else state.selected.add(item.id);
  // The text has done its job; all lists show again for the next pick.
  if (state.search.value) {
    state.search.value = '';
    state.active = item.create ? 0 : options(state).findIndex((option) => option.id === item.id);
  }
  render(root);
}

// Each name before the last comma becomes a chip: a list with that name (in any case) is
// ticked, any other name is made a new list. The text after the last comma stays in the box.
function takeNames(root) {
  const state = states.get(root);
  const parts = state.search.value.split(',');
  state.search.value = parts.pop().trimStart();
  for (const name of parts.map((part) => part.trim()).filter(Boolean)) {
    const lower = name.toLowerCase();
    const list = state.lists.find((l) => l.name.toLowerCase() === lower);
    if (list) state.selected.add(list.id);
    else if (!state.created.some((created) => created.toLowerCase() === lower)) state.created.push(name);
  }
}

function unchoose(root, id, name) {
  const state = states.get(root);
  if (id) state.selected.delete(id);
  else state.created = state.created.filter((created) => created !== name);
  render(root);
}

function setOpen(root, open) {
  const state = states.get(root);
  if (open) root.dataset.open = '';
  else delete root.dataset.open;
  state.search.setAttribute('aria-expanded', String(open));
  render(root);
}

function render(root) {
  const state = states.get(root);
  const { search, panel, field } = state;
  const byId = new Map(state.lists.map((list) => [list.id, list]));
  const chips = [
    ...[...state.selected].map((id) => chip(byId.get(id).name, { id })),
    ...state.created.map((name) => chip(name, { name, isNew: true })),
  ];
  // The box itself stays put, so it keeps the focus.
  for (const old of field.querySelectorAll('.list-choice__chip')) old.remove();
  search.before(...chips);

  const untouched = state.lastUsed !== null && !state.created.length && key(state.selected) === state.lastUsed;
  field.title = untouched ? 'The lists used last time' : '';
  const focused = document.activeElement === search;
  if (chips.length) search.placeholder = '';
  else if (focused) search.placeholder = 'Search or create a list…';
  else search.placeholder = untouched ? `Last used: ${NO_LIST_NAME}` : state.emptyLabel;

  const open = 'open' in root.dataset;
  panel.hidden = !open;
  if (!open) return search.removeAttribute('aria-activedescendant');
  const items = options(state);
  state.active = Math.min(state.active, Math.max(items.length - 1, 0));
  panel.replaceChildren(
    ...items.map((item, index) => {
      const option = document.createElement('div');
      option.className = 'list-choice__option';
      option.id = `${panel.id}-${index}`;
      option.dataset.index = index;
      option.setAttribute('role', 'option');
      option.classList.toggle('list-choice__option--active', index === state.active);
      if (item.create) {
        option.classList.add('list-choice__option--create');
        option.textContent = `Create list “${item.name}”`;
      } else {
        const ticked = state.selected.has(item.id);
        option.setAttribute('aria-selected', String(ticked));
        option.style.paddingLeft = `${8 + item.depth * 16}px`;
        const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: ticked, tabIndex: -1 });
        box.setAttribute('aria-hidden', 'true');
        option.append(box, item.name);
      }
      return option;
    }),
  );
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'list-choice__empty';
    empty.textContent = 'Type a name to create a list.';
    panel.append(empty);
  }
  const active = panel.children[state.active];
  if (items.length && active) {
    search.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
  } else {
    search.removeAttribute('aria-activedescendant');
  }
}

function chip(name, { id = '', isNew = false }) {
  const element = document.createElement('span');
  element.className = 'list-choice__chip';
  if (isNew) element.title = 'New list, made when you save';
  const label = document.createElement('span');
  label.className = 'list-choice__chip-name';
  label.textContent = isNew ? `+ ${name}` : name;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'list-choice__chip-remove';
  remove.tabIndex = -1;
  remove.ariaLabel = `Remove ${name}`;
  remove.title = 'Remove';
  remove.dataset.id = id;
  remove.dataset.name = name;
  remove.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  element.append(label, remove);
  return element;
}
