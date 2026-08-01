// Minimal XML parser for plex.tv v1 API responses (attribute-centric documents,
// no DOMParser on Cloudflare Workers). Handles elements, attributes, self-closing
// tags, comments, CDATA-free documents — exactly the shape plex.tv emits.

export type XmlNode = {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
};

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

export function decodeXmlEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (entity) => {
    if (ENTITY_MAP[entity]) return ENTITY_MAP[entity];
    if (entity.startsWith("&#x") || entity.startsWith("&#X")) {
      return String.fromCodePoint(parseInt(entity.slice(3, -1), 16));
    }
    return String.fromCodePoint(parseInt(entity.slice(2, -1), 10));
  });
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    attrs[m[1]] = decodeXmlEntities(m[2]);
  }
  return attrs;
}

export function parseXml(input: string): XmlNode {
  const cleaned = input.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const root: XmlNode = { tag: "#root", attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  const tagRe = /<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"]|"[^"]*")*?)(\/?)>/g;
  let m: RegExpExecArray | null;

  while ((m = tagRe.exec(cleaned)) !== null) {
    const [, closing, tag, rawAttrs, selfClosing] = m;
    if (closing) {
      // Pop back to the matching open tag; tolerate mismatches.
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const node: XmlNode = { tag, attrs: parseAttrs(rawAttrs), children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root;
}

export function findAll(node: XmlNode, tag: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode) => {
    for (const child of n.children) {
      if (child.tag === tag) out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

export function findFirst(node: XmlNode, tag: string): XmlNode | null {
  return findAll(node, tag)[0] ?? null;
}

// Plex timestamps are unix epoch seconds (as strings); "0" or "" mean unset.
export function epochToIso(value: string | undefined): string | null {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}
