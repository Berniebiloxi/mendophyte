import { marked } from "marked";

/**
 * Markdown to HTML for artifact files the agent wrote. They're local,
 * single-user content, but they are model output, so strip anything
 * executable before it reaches the DOM.
 */
export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false, gfm: true, breaks: false }) as string;
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of Array.from(doc.querySelectorAll("script, iframe, object, embed, link, meta, style, form"))) el.remove();
  for (const el of Array.from(doc.body.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      const n = attr.name.toLowerCase();
      if (n.startsWith("on") || ((n === "href" || n === "src") && /^\s*javascript:/i.test(attr.value))) el.removeAttribute(attr.name);
    }
    if (el.tagName === "A") {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
  }
  return doc.body.innerHTML;
}

/** Inline Markdown (bold, code, links) for a single line such as a question or a prompt. */
export function renderInline(src: string): string {
  const html = marked.parseInline(src, { async: false, gfm: true }) as string;
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  for (const el of Array.from(doc.querySelectorAll("script, iframe, object, embed, link, meta, style, form, img"))) el.remove();
  for (const el of Array.from(doc.body.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      const n = attr.name.toLowerCase();
      if (n.startsWith("on") || (n === "href" && /^\s*javascript:/i.test(attr.value))) el.removeAttribute(attr.name);
    }
    if (el.tagName === "A") {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
  }
  return doc.body.firstElementChild?.innerHTML ?? "";
}

export interface MdSection {
  /** Heading text without the hashes; null for text before the first heading. */
  title: string | null;
  level: number;
  body: string;
}

/**
 * Splits a reply at its headings (levels 1–4) so each part can be drawn as
 * its own box. Fenced code is never split. A reply without headings is
 * one section with a null title.
 */
export function splitSections(md: string): MdSection[] {
  const out: MdSection[] = [];
  let cur: MdSection = { title: null, level: 0, body: "" };
  let fence: string | null = null;
  for (const line of md.split(/\r?\n/)) {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) fence = fence === f[1] ? null : fence ?? f[1];
    const h = !fence && /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      if (cur.title !== null || cur.body.trim()) out.push(cur);
      cur = { title: h[2].trim(), level: h[1].length, body: "" };
      continue;
    }
    cur.body += line + "\n";
  }
  if (cur.title !== null || cur.body.trim()) out.push(cur);
  return out;
}

/** True when the text has any block-level Markdown worth rendering (headings, lists, tables, fences, bold). */
export function looksLikeMarkdown(s: string): boolean {
  return /(^|\n)\s*(#{1,4}\s|[-*+]\s|\d+\.\s|\|.*\||```|>\s)/.test(s) || /\*\*[^*]+\*\*|`[^`]+`/.test(s);
}
