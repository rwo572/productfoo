// A minimal, dependency-free Atom reader — just enough to parse the two Atom
// feeds this module consumes (Reddit search.rss and the arXiv query API). It is
// deliberately lenient (regex over well-formed, regular feeds) rather than a
// general XML parser; fixtures in the test suite pin the shapes it must handle.

export interface AtomEntry {
  id: string | null;
  title: string | null;
  link: string | null;
  published: string | null;
  author: string | null;
  summary: string | null;
}

function firstTag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1].trim() : null;
}

function linkHref(block: string): string | null {
  // Prefer an alternate/self <link href="…">; fall back to a text <link>…</link>.
  const href = block.match(/<link\b[^>]*\bhref="([^"]+)"/i);
  if (href) return href[1];
  return firstTag(block, "link");
}

function authorName(block: string): string | null {
  const author = block.match(/<author\b[^>]*>([\s\S]*?)<\/author>/i);
  if (!author) return null;
  return firstTag(author[1], "name");
}

export function unescapeXml(value: string | null): string | null {
  if (value == null) return null;
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, "") // strip any inline markup left in titles/summaries
    .trim();
}

export function parseAtomEntries(xml: string): AtomEntry[] {
  const blocks = xml.split(/<entry\b/i).slice(1);
  return blocks.map((raw) => {
    const block = raw.split(/<\/entry>/i)[0];
    return {
      id: firstTag(block, "id"),
      title: unescapeXml(firstTag(block, "title")),
      link: linkHref(block),
      published: firstTag(block, "published") ?? firstTag(block, "updated"),
      author: authorName(block),
      summary: unescapeXml(firstTag(block, "summary")),
    };
  });
}
