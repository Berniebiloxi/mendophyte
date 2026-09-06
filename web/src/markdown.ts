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
