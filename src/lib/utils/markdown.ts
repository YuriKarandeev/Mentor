import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

/** Markdown → безопасный HTML (DOMPurify против XSS из ответов модели/веб-страниц). */
export function renderMarkdown(src: string): string {
  if (!src) return '';
  const raw = marked.parse(src, { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel'],
    FORBID_TAGS: ['style', 'form', 'input', 'button']
  });
}

export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_>`~\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
