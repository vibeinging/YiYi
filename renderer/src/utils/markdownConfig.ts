import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import markedKatex from "marked-katex-extension";
import createDOMPurify from "dompurify";
import hljs from 'highlight.js';
import "highlight.js/styles/ir-black.css";
import "katex/dist/katex.min.css";

const marked = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code: any, lang: any, info: any) {
      const language = hljs.getLanguage(lang) ? lang : 'plaintext';
      return hljs.highlight(code, { language }).value;
    }
  }),
  markedKatex({
    throwOnError: false,
    output: 'html'
  })
);

marked.setOptions({ breaks: true, gfm: true });

const purifier = typeof window === 'undefined' ? null : createDOMPurify(window);
const SAFE_URI_PATTERN = /^(?:(?:https?|mailto|tel|blob|yiw-file):|data:image\/(?:png|gif|jpe?g|webp|svg\+xml);|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i;

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

/** Shared trust boundary for every renderer that uses the configured Marked instance. */
export function sanitizeMarkdownHtml(html: string): string {
  if (!purifier) return escapeHtml(String(html || ''));
  return purifier.sanitize(String(html || ''), {
    ALLOWED_URI_REGEXP: SAFE_URI_PATTERN,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
    RETURN_TRUSTED_TYPE: false,
  });
}

marked.use({
  hooks: {
    postprocess(html) {
      return sanitizeMarkdownHtml(html);
    },
  },
});

// 提取标题生成目录
export function extractToc(markdown: any) {
  const headings: any[] = [];
  const tokens = marked.lexer(markdown);

  tokens.forEach((token: any) => {
    if (token.type === 'heading' && token.depth >= 2) {
      headings.push({
        level: token.depth,
        text: token.text,
        id: token.text
          .toLowerCase()
          .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
          .replace(/^-+|-+$/g, '')
      });
    }
  });

  return headings;
}

export default marked;
