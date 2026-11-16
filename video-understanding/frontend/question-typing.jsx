import { useEffect } from 'react';

const motion = window.matchMedia('(prefers-reduced-motion: no-preference)');
const segmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;
const duration = 210;

function getInsertion(previous, value, caret) {
  const tail = previous.value.slice(previous.end);
  const end = value.length - tail.length;
  const matchingSelection = end === caret && end > previous.start
    && value.startsWith(previous.value.slice(0, previous.start)) && value.endsWith(tail);
  if (matchingSelection) return { start: previous.start, end };

  let start = 0;
  let oldEnd = previous.value.length;
  let newEnd = value.length;
  while (start < oldEnd && start < newEnd && previous.value[start] === value[start]) start++;
  while (oldEnd > start && newEnd > start && previous.value[oldEnd - 1] === value[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return { start, end: newEnd };
}

export default function QuestionTyping() {
  useEffect(() => {
    const input = document.querySelector('#question');
    const layer = document.querySelector('#question-glyphs');
    const text = layer.firstElementChild;
    const events = new AbortController();
    const options = { signal: events.signal };
    const read = () => ({ value: input.value, start: input.selectionStart, end: input.selectionEnd });
    let previous = read();
    let composition;
    let compositionFrame = 0;
    let scrollFrame = 0;
    let animated = [];

    function clear() {
      cancelAnimationFrame(scrollFrame);
      animated = [];
      input.classList.remove('is-animating');
      text.replaceChildren();
    }

    function syncScroll() {
      text.style.transform = `translateX(${-input.scrollLeft}px)`;
    }

    function render() {
      const now = performance.now();
      animated = animated.filter(glyph => glyph.until > now);
      if (!animated.length) {
        clear();
        return;
      }

      const content = document.createDocumentFragment();
      const value = input.value;
      let offset = 0;
      for (const glyph of animated) {
        content.append(value.slice(offset, glyph.start));
        const span = document.createElement('span');
        span.className = 'question-glyph';
        span.textContent = value.slice(glyph.start, glyph.end);
        span.style.animationDelay = `${glyph.until - now - duration}ms`;
        content.append(span);
        offset = glyph.end;
      }
      content.append(value.slice(offset));
      text.replaceChildren(content);
      syncScroll();
      input.classList.add('is-animating');
      cancelAnimationFrame(scrollFrame);
      scrollFrame = requestAnimationFrame(syncScroll);
    }

    function showInsertion(before) {
      if (!motion.matches || input.disabled || document.activeElement !== input
          || input.selectionStart !== input.selectionEnd || before.value === input.value) {
        clear();
        return;
      }
      const { start, end } = getInsertion(before, input.value, input.selectionEnd);
      const inserted = input.value.slice(start, end);
      if (!inserted) {
        clear();
        return;
      }
      const delta = input.value.length - before.value.length;
      const replacedEnd = end - delta;
      animated = animated
        .filter(glyph => glyph.end <= start || glyph.start >= replacedEnd)
        .map(glyph => glyph.end <= start ? glyph : { ...glyph, start: glyph.start + delta, end: glyph.end + delta });

      const segments = segmenter
        ? Array.from(segmenter.segment(inserted), item => item.segment)
        : Array.from(inserted);
      let offset = start;
      const until = performance.now() + duration;
      for (const segment of segments) {
        animated.push({ start: offset, end: offset + segment.length, until });
        offset += segment.length;
      }
      animated.sort((a, b) => a.start - b.start);
      render();
    }

    input.addEventListener('beforeinput', () => {
      previous = read();
    }, options);
    input.addEventListener('input', event => {
      if (composition || compositionFrame || event.isComposing) return;
      if (event.inputType?.startsWith('insert')) showInsertion(previous);
      else clear();
      previous = read();
    }, options);
    input.addEventListener('compositionstart', () => {
      clear();
      cancelAnimationFrame(compositionFrame);
      compositionFrame = 0;
      composition = read();
    }, options);
    input.addEventListener('compositionend', event => {
      const before = composition;
      composition = undefined;
      compositionFrame = requestAnimationFrame(() => {
        compositionFrame = 0;
        if (before && event.data) showInsertion(before);
        previous = read();
      });
    }, options);
    input.addEventListener('focus', () => { previous = read(); }, options);
    input.addEventListener('blur', () => {
      cancelAnimationFrame(compositionFrame);
      compositionFrame = 0;
      composition = undefined;
      clear();
    }, options);
    input.addEventListener('pointerdown', clear, options);
    input.addEventListener('selectionchange', () => {
      if (input.selectionStart !== input.selectionEnd) clear();
    }, options);
    input.addEventListener('scroll', syncScroll, options);
    text.addEventListener('animationend', () => {
      if (animated.every(glyph => glyph.until <= performance.now())) clear();
    }, options);
    motion.addEventListener('change', clear, options);

    const observer = new MutationObserver(() => {
      if (input.disabled) clear();
    });
    observer.observe(input, { attributes: true, attributeFilter: ['disabled'] });
    return () => {
      events.abort();
      observer.disconnect();
      cancelAnimationFrame(compositionFrame);
      clear();
    };
  }, []);
  return null;
}
