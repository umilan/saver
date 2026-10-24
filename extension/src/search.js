// The dashboard's search syntax. A query is split into parts, and an item must match them all:
//
//   lamp            the word is in the title, shop, note or a list name (any case)
//   "desk lamp"     the exact phrase
//   [home]          in the list or shop called home (with its sub-lists); [all] means every
//                   item, [unsorted] those in no list. A query with one searches everywhere,
//                   not only in the list that is open.
//   -lamp  -[home]  NOT: leaves out what the part matches
//   shop:ikea       from a shop whose name has "ikea"
//   price<50  price>20  price:20-50   price in the currency shown (the settings' currency)
//   has:note  has:price  has:picture  has:list    and no:… for the opposite
//   is:cheaper  is:pricier   the price went down / up since it was saved
//
// parseQuery gives { parts, words }: parts to test, words the plain text to mark in results.

const TOKEN = /(-?)(?:"([^"]*)"?|\[([^\]]*)\]?|(\S+))/g;
const FLAGS = ['note', 'price', 'picture', 'list'];

export function parseQuery(text) {
  const parts = [];
  const words = [];
  for (const [, minus, phrase, list, word] of text.matchAll(TOKEN)) {
    const not = minus === '-';
    if (list !== undefined) {
      const name = list.trim().toLowerCase();
      if (name) parts.push({ kind: 'list', name, not });
      continue;
    }
    if (phrase !== undefined) {
      const value = phrase.trim().toLowerCase();
      if (!value) continue;
      parts.push({ kind: 'text', value, not });
      if (!not) words.push(value);
      continue;
    }
    if (!word) continue;
    const lower = word.toLowerCase();
    let match;
    if ((match = lower.match(/^shop:(.+)$/))) {
      parts.push({ kind: 'shop', value: match[1], not });
    } else if ((match = lower.match(/^price(<=?|>=?|:)(\d+(?:[.,]\d+)?)(?:-(\d+(?:[.,]\d+)?))?$/))) {
      const [, op, from, to] = match;
      const a = Number(from.replace(',', '.'));
      const b = to === undefined ? null : Number(to.replace(',', '.'));
      const test = {
        '<': (price) => price < a,
        '<=': (price) => price <= a,
        '>': (price) => price > a,
        '>=': (price) => price >= a,
        ':': (price) => (b === null ? Math.round(price) === Math.round(a) : price >= a && price <= b),
      }[op];
      parts.push({ kind: 'price', test, not });
    } else if ((match = lower.match(/^(has|no):(\w+)$/)) && FLAGS.includes(match[2])) {
      parts.push({ kind: 'has', flag: match[2], not: not !== (match[1] === 'no') });
    } else if (lower === 'is:cheaper' || lower === 'is:pricier') {
      parts.push({ kind: 'change', down: lower === 'is:cheaper', not });
    } else if (lower !== '-') {
      parts.push({ kind: 'text', value: lower, not });
      if (!not) words.push(lower);
    }
  }
  return { parts, words };
}
