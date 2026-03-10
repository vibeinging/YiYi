/**
 * MentionInput — contentEditable input with inline @mention tags
 *
 * Mention tags are non-editable styled spans embedded in the text flow.
 * Example: [@Discord Bot] 吃饭了吗
 */

import { useRef, useImperativeHandle, forwardRef, useCallback, useEffect } from 'react';

export interface MentionTag {
  type: 'bot' | 'file';
  id: string;
  name: string;
}

export interface MentionInputHandle {
  focus: () => void;
  insertMention: (tag: MentionTag) => void;
  insertText: (text: string) => void;
  getPlainText: () => string;
  getMentions: () => MentionTag[];
  clear: () => void;
  isEmpty: () => boolean;
  getElement: () => HTMLDivElement | null;
}

interface MentionInputProps {
  placeholder?: string;
  disabled?: boolean;
  maxHeight?: number;
  onInput?: (text: string) => void;
  onMentionTrigger?: (query: string) => void;
  onMentionDismiss?: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  onPaste?: (e: React.ClipboardEvent) => void;
}

/** Create a mention span element */
function createMentionSpan(tag: MentionTag): HTMLSpanElement {
  const span = document.createElement('span');
  span.contentEditable = 'false';
  span.setAttribute('data-mention', '');
  span.setAttribute('data-type', tag.type);
  span.setAttribute('data-id', tag.id);
  span.setAttribute('data-name', tag.name);
  span.textContent = `@${tag.name}`;

  // Bot: purple / File: muted
  if (tag.type === 'bot') {
    span.style.cssText = `
      background: rgba(99,102,241,0.15);
      color: rgb(99,102,241);
      padding: 1px 6px;
      border-radius: 6px;
      font-weight: 500;
      font-size: 13px;
      margin: 0 2px;
      user-select: all;
      white-space: nowrap;
    `;
  } else {
    span.style.cssText = `
      background: var(--color-bg-subtle);
      color: var(--color-text-secondary);
      padding: 1px 6px;
      border-radius: 6px;
      font-size: 13px;
      margin: 0 2px;
      user-select: all;
      white-space: nowrap;
    `;
  }
  return span;
}

/** Extract plain text from the contentEditable div (mention spans → @name) */
function extractPlainText(el: HTMLDivElement): string {
  let text = '';
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent || '';
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const elem = node as HTMLElement;
      if (elem.hasAttribute('data-mention')) {
        // Include mention as @name in plain text
        const name = elem.getAttribute('data-name') || '';
        text += `@${name}`;
        continue;
      }
      // Handle <br> as newline
      if (elem.tagName === 'BR') {
        text += '\n';
      } else {
        // Recurse into other elements (div wraps lines in some browsers)
        text += extractPlainText(elem as HTMLDivElement);
        // Add newline after block-level elements (Chrome wraps lines in divs)
        if (elem.tagName === 'DIV' || elem.tagName === 'P') {
          text += '\n';
        }
      }
    }
  }
  return text;
}

/** Extract all MentionTag from the contentEditable div */
function extractMentions(el: HTMLDivElement): MentionTag[] {
  const spans = el.querySelectorAll('[data-mention]');
  const result: MentionTag[] = [];
  spans.forEach((span) => {
    result.push({
      type: (span.getAttribute('data-type') as 'bot' | 'file') || 'file',
      id: span.getAttribute('data-id') || '',
      name: span.getAttribute('data-name') || '',
    });
  });
  return result;
}

/** Find @query pattern before cursor in contentEditable */
function detectAtTrigger(el: HTMLDivElement): string | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);

  // Only detect in text nodes
  if (range.startContainer.nodeType !== Node.TEXT_NODE) return null;

  const textNode = range.startContainer as Text;
  const textBefore = textNode.textContent?.slice(0, range.startOffset) || '';

  // Match @ at start or after whitespace
  const match = textBefore.match(/(?:^|[\s])@([^\s@]*)$/);
  return match ? match[1] : null;
}

/** Remove the @query text before cursor and return the range for insertion */
function removeAtQuery(el: HTMLDivElement): Range | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);

  if (range.startContainer.nodeType !== Node.TEXT_NODE) return null;

  const textNode = range.startContainer as Text;
  const textBefore = textNode.textContent?.slice(0, range.startOffset) || '';
  const match = textBefore.match(/(^|[\s])@[^\s@]*$/);
  if (!match) return null;

  // Calculate where the @ starts (keeping the leading space/start)
  const atStart = match.index! + match[1].length;
  const atEnd = range.startOffset;

  // Delete the @query text
  textNode.deleteData(atStart, atEnd - atStart);

  // Create a range at the deletion point
  const insertRange = document.createRange();
  insertRange.setStart(textNode, atStart);
  insertRange.collapse(true);
  return insertRange;
}

export const MentionInput = forwardRef<MentionInputHandle, MentionInputProps>(
  ({ placeholder, disabled, maxHeight = 160, onInput, onMentionTrigger, onMentionDismiss, onKeyDown, onPaste }, ref) => {
    const divRef = useRef<HTMLDivElement>(null);

    // Place cursor after a given node
    const placeCursorAfter = useCallback((node: Node) => {
      const sel = window.getSelection();
      if (!sel) return;
      const range = document.createRange();
      range.setStartAfter(node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }, []);

    useImperativeHandle(ref, () => ({
      focus: () => divRef.current?.focus(),
      getElement: () => divRef.current,

      insertText: (text: string) => {
        const el = divRef.current;
        if (!el) return;
        el.focus();
        document.execCommand('insertText', false, text);
        onInput?.(extractPlainText(el));
      },

      insertMention: (tag: MentionTag) => {
        const el = divRef.current;
        if (!el) return;

        // Remove @query text and get insertion point
        const insertRange = removeAtQuery(el);
        const span = createMentionSpan(tag);

        if (insertRange) {
          insertRange.insertNode(span);
        } else {
          // Fallback: append at end
          el.appendChild(span);
        }

        // Add a trailing space after the mention and place cursor there
        const space = document.createTextNode('\u00A0');
        if (span.nextSibling) {
          span.parentNode!.insertBefore(space, span.nextSibling);
        } else {
          span.parentNode!.appendChild(space);
        }
        placeCursorAfter(space);

        // Notify parent
        onInput?.(extractPlainText(el));
        onMentionDismiss?.();
      },

      getPlainText: () => {
        return divRef.current ? extractPlainText(divRef.current).trim() : '';
      },

      getMentions: () => {
        return divRef.current ? extractMentions(divRef.current) : [];
      },

      clear: () => {
        if (divRef.current) {
          divRef.current.innerHTML = '';
          onInput?.('');
        }
      },

      isEmpty: () => {
        if (!divRef.current) return true;
        const text = extractPlainText(divRef.current).trim();
        const mentions = extractMentions(divRef.current);
        return text.length === 0 && mentions.length === 0;
      },
    }), [onInput, onMentionDismiss, placeCursorAfter]);

    // Handle input events — detect @ trigger and notify parent
    const handleInput = useCallback(() => {
      const el = divRef.current;
      if (!el) return;

      const text = extractPlainText(el);
      onInput?.(text);

      // Detect @trigger
      const query = detectAtTrigger(el);
      if (query !== null) {
        onMentionTrigger?.(query);
      } else {
        onMentionDismiss?.();
      }
    }, [onInput, onMentionTrigger, onMentionDismiss]);

    // Prevent rich-text paste — only plain text
    const handlePaste = useCallback((e: React.ClipboardEvent) => {
      // Let parent handle file pastes
      const items = Array.from(e.clipboardData.items);
      const hasFiles = items.some(item => item.kind === 'file');
      if (hasFiles) {
        onPaste?.(e);
        return;
      }

      // Plain text only
      e.preventDefault();
      const text = e.clipboardData.getData('text/plain');
      if (text) {
        document.execCommand('insertText', false, text);
      }
    }, [onPaste]);

    // Auto-resize
    useEffect(() => {
      const el = divRef.current;
      if (!el) return;

      const observer = new MutationObserver(() => {
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
      });
      observer.observe(el, { childList: true, subtree: true, characterData: true });
      return () => observer.disconnect();
    }, [maxHeight]);

    return (
      <div
        ref={divRef}
        contentEditable={!disabled}
        role="textbox"
        aria-placeholder={placeholder}
        data-placeholder={placeholder}
        suppressContentEditableWarning
        onInput={handleInput}
        onKeyDown={onKeyDown}
        onPaste={handlePaste}
        className="mention-input flex-1 bg-transparent border-none outline-none text-[14px] px-2 py-1.5 overflow-y-auto"
        style={{
          color: 'var(--color-text)',
          maxHeight: maxHeight + 'px',
          minHeight: '24px',
          lineHeight: '1.5',
          wordBreak: 'break-word',
          whiteSpace: 'pre-wrap',
        }}
      />
    );
  },
);

MentionInput.displayName = 'MentionInput';
