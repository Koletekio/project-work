'use client';

import { Fragment, forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './VariableProximity.css';

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

const GAUSSIAN_EDGE = Math.exp(-2);
const WAVE_PERIOD = 3.2;
const WAVE_PEAK = 0.7;
const REPEL_STIFFNESS = 190;
const REPEL_DAMPING = 19;

const advanceRepelSpring = (state, delta, limit) => {
  const steps = Math.max(1, Math.ceil(delta * 0.12));
  const step = delta / (1000 * steps);
  for (let index = 0; index < steps; index++) {
    state.vx += ((state.targetX - state.x) * REPEL_STIFFNESS - state.vx * REPEL_DAMPING) * step;
    state.vy += ((state.targetY - state.y) * REPEL_STIFFNESS - state.vy * REPEL_DAMPING) * step;
    state.x += state.vx * step;
    state.y += state.vy * step;
    const offset = Math.hypot(state.x, state.y);
    if (offset > limit) {
      const outward = Math.max(0, (state.vx * state.x + state.vy * state.y) / offset);
      state.vx -= (outward * state.x) / offset;
      state.vy -= (outward * state.y) / offset;
      state.x *= limit / offset;
      state.y *= limit / offset;
    }
  }
  if (Math.hypot(state.x - state.targetX, state.y - state.targetY) >= 0.02 ||
      Math.hypot(state.vx, state.vy) >= 0.2) return true;
  state.x = state.targetX;
  state.y = state.targetY;
  state.vx = state.vy = 0;
  return false;
};

const parseSettings = settings =>
  new Map(
    settings
      .split(',')
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => {
        const [name, value] = part.split(/\s+/);
        return [name.replace(/['"]/g, ''), parseFloat(value)];
      })
  );

const strengthAt = (distance, radius, falloff) => {
  if (distance >= radius) return 0;
  const norm = 1 - distance / radius;
  switch (falloff) {
    case 'exponential':
      return norm * norm;
    case 'gaussian':
      return (Math.exp(-2 * (distance / radius) ** 2) - GAUSSIAN_EDGE) / (1 - GAUSSIAN_EDGE);
    case 'linear':
    default:
      return norm;
  }
};

const VariableProximity = forwardRef((props, ref) => {
  const {
    label = '',
    fromFontVariationSettings = "'wght' 400, 'opsz' 9",
    toFontVariationSettings = "'wght' 1000, 'opsz' 40",
    containerRef,
    radius = 50,
    falloff = 'linear',
    smoothing = 0.2,
    fromColor,
    toColor,
    scale = 1,
    lift = 0,
    repelDistance = 0,
    idleWave = false,
    fontSize,
    className = '',
    onClick,
    style,
    ...restProps
  } = props;

  const rootRef = useRef(null);
  const letterRefs = useRef([]);
  const stateRef = useRef({ pointer: { x: 0, y: 0, active: false }, levels: [], targets: [] });
  const [lineStarts, setLineStarts] = useState(null);
  const explicitLines = label.includes('\n');

  const setRoot = useCallback(
    node => {
      rootRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref]
  );

  const axes = useMemo(() => {
    const fromSettings = parseSettings(fromFontVariationSettings);
    const toSettings = parseSettings(toFontVariationSettings);
    return Array.from(fromSettings.entries()).map(([axis, fromValue]) => ({
      axis,
      fromValue,
      toValue: toSettings.get(axis) ?? fromValue
    }));
  }, [fromFontVariationSettings, toFontVariationSettings]);

  useIsoLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || explicitLines) return;
    let frame = 0;
    let live = true;
    let lastWidth = -1;

    const measure = () => {
      frame = 0;
      if (!live) return;
      const words = Array.from(root.querySelectorAll('[data-word]'));
      const breaks = Array.from(root.querySelectorAll('br'));
      const letters = letterRefs.current.filter(Boolean);
      const saved = letters.map(letter => letter.style.fontVariationSettings);
      const wrap = root.style.whiteSpace;
      root.style.whiteSpace = 'normal';
      breaks.forEach(node => (node.style.display = 'none'));
      letters.forEach(letter => (letter.style.fontVariationSettings = fromFontVariationSettings));
      const starts = [];
      let lastTop = null;
      words.forEach((word, index) => {
        const top = word.getBoundingClientRect().top;
        if (lastTop !== null && top > lastTop + 2) starts.push(index);
        lastTop = top;
      });
      letters.forEach((letter, index) => (letter.style.fontVariationSettings = saved[index]));
      breaks.forEach(node => (node.style.display = ''));
      root.style.whiteSpace = wrap;
      const key = starts.join(',');
      setLineStarts(previous => (previous === key ? previous : key));
    };

    const queue = entries => {
      const width = entries?.[0]?.contentRect.width;
      if (width !== undefined) {
        if (Math.abs(width - lastWidth) < 1) return;
        lastWidth = width;
      }
      if (!frame) frame = requestAnimationFrame(measure);
    };

    measure();
    const parent = root.parentElement;
    const observer = parent && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(queue) : null;
    if (parent) observer?.observe(parent);
    document.fonts?.ready.then(() => queue());

    return () => {
      live = false;
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [label, fromFontVariationSettings, fontSize, explicitLines]);

  useEffect(() => {
    const { pointer, levels, targets } = stateRef.current;
    const written = [];
    const painted = [];
    const moved = [];
    const anchors = [];
    const repulsion = [];
    const tinted = Boolean(fromColor || toColor);
    const restColor = fromColor || 'currentColor';
    const nearColor = toColor || 'currentColor';
    const growth = (Number(scale) || 1) - 1;
    const rise = Number(lift) || 0;
    const transformed = growth !== 0 || rise !== 0;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const repelLimit = reduced ? 0 : Math.max(0, Number(repelDistance) || 0);
    const waving = idleWave && !reduced;
    let frame = 0;
    let lastTime = 0;
    let dirty = true;
    let layoutDirty = true;
    let nearAny = false;
    let lastNear = -Infinity;
    let waveMix = 0;
    let span = 1;
    let visible = true;

    letterRefs.current.forEach(letter => {
      if (!letter) return;
      if (!tinted) letter.style.color = '';
      if (!transformed) letter.style.transform = '';
    });
    if (repelLimit) {
      for (const letter of letterRefs.current) {
        repulsion.push(letter ? { x: 0, y: 0, vx: 0, vy: 0, targetX: 0, targetY: 0 } : null);
      }
    }

    const settingsAt = level =>
      axes.map(({ axis, fromValue, toValue }) => `'${axis}' ${fromValue + (toValue - fromValue) * level}`).join(', ');

    const measureAnchors = () => {
      const letters = letterRefs.current;
      let left = Infinity;
      let top = Infinity;
      let right = -Infinity;
      letters.forEach((letter, index) => {
        if (!letter) return;
        const rect = letter.getBoundingClientRect();
        anchors[index] = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        left = Math.min(left, rect.left);
        top = Math.min(top, rect.top);
        right = Math.max(right, rect.right);
      });
      anchors.forEach(anchor => {
        anchor.x -= left;
        anchor.y -= top;
      });
      span = Math.max(220, (right - left) * 0.85);
    };

    const measure = () => {
      const letters = letterRefs.current;
      targets.length = letters.length;
      targets.fill(0);
      for (const state of repulsion) {
        if (state) state.targetX = state.targetY = 0;
      }
      nearAny = false;
      if (!pointer.active) return;

      const area = containerRef?.current?.getBoundingClientRect();
      if (area) {
        const dx = Math.max(area.left - pointer.x, 0, pointer.x - area.right);
        const dy = Math.max(area.top - pointer.y, 0, pointer.y - area.bottom);
        if (dx * dx + dy * dy >= radius * radius) return;
      }

      letters.forEach((letter, index) => {
        if (!letter) return;
        const rect = letter.getBoundingClientRect();
        const spring = repulsion[index];
        // Read the layout center, subtracting the last offset to avoid feedback as the letter moves.
        const dx = rect.left + rect.width / 2 - (spring?.x ?? 0) - pointer.x;
        const dy = rect.top + rect.height / 2 - (spring?.y ?? 0) - pointer.y;
        const distance = Math.hypot(dx, dy);
        const influence = strengthAt(distance, radius, falloff);
        targets[index] = influence;
        if (spring && influence > 0) {
          const amount = influence * repelLimit;
          spring.targetX = distance > .001 ? amount * dx / distance : amount;
          spring.targetY = distance > .001 ? amount * dy / distance : 0;
        }
        if (targets[index] > 0) nearAny = true;
      });
    };

    const waveAt = (index, time) => {
      const anchor = anchors[index];
      if (!anchor) return 0;
      const phase = ((anchor.x + anchor.y * 0.6) / span - time / WAVE_PERIOD) * Math.PI * 2;
      return WAVE_PEAK * ((1 + Math.cos(phase)) / 2) ** 2.2;
    };

    const tick = now => {
      frame = 0;
      const delta = lastTime ? Math.min(now - lastTime, 64) : 16;
      lastTime = now;

      if (dirty) {
        measure();
        dirty = false;
      }
      if (waving && layoutDirty) {
        measureAnchors();
        layoutDirty = false;
      }

      if (nearAny) lastNear = now;
      const idle = waving && visible && !nearAny && now - lastNear > 500;
      const goal = idle ? 1 : 0;
      waveMix += (goal - waveMix) * (1 - Math.exp(-delta / 600));
      if (Math.abs(goal - waveMix) < 0.002) waveMix = goal;

      const ease = smoothing > 0 ? 1 - Math.exp(-delta / (smoothing * 400)) : 1;
      const time = now / 1000;
      let settling = false;

      letterRefs.current.forEach((letter, index) => {
        if (!letter) return;
        let target = targets[index] ?? 0;
        if (waveMix > 0) target = Math.max(target, waveMix * waveAt(index, time));
        const current = levels[index] ?? 0;
        let next = current + (target - current) * ease;
        if (Math.abs(target - next) < 0.002) {
          next = target;
        } else {
          settling = true;
        }
        levels[index] = next;

        const settings = next === 0 ? fromFontVariationSettings : settingsAt(next);
        if (written[index] !== settings) {
          written[index] = settings;
          letter.style.fontVariationSettings = settings;
        }

        if (tinted) {
          const paint =
            next === 0
              ? fromColor || ''
              : `color-mix(in oklab, ${restColor} ${((1 - next) * 100).toFixed(1)}%, ${nearColor})`;
          if (painted[index] !== paint) {
            painted[index] = paint;
            letter.style.color = paint;
          }
        }

        const spring = repulsion[index];
        if (spring && advanceRepelSpring(spring, delta, repelLimit)) settling = true;
        if (transformed || spring) {
          const baseShift =
            next === 0 ? '' : `translateY(${(-rise * next).toFixed(3)}em) scale(${(1 + growth * next).toFixed(3)})`;
          const repelShift = spring && (spring.x || spring.y) ? `translate3d(${spring.x}px, ${spring.y}px, 0)` : '';
          const shift = `${repelShift} ${transformed ? baseShift : ''}`.trim();
          if (moved[index] !== shift) {
            moved[index] = shift;
            letter.style.transform = shift;
          }
        }
      });

      if (settling || waveMix > 0 || (waving && visible && !nearAny)) {
        frame = requestAnimationFrame(tick);
      } else {
        lastTime = 0;
      }
    };

    const schedule = () => {
      dirty = true;
      if (!frame) frame = requestAnimationFrame(tick);
    };

    const relayout = () => {
      layoutDirty = true;
      schedule();
    };

    const handleMove = (x, y) => {
      pointer.x = x;
      pointer.y = y;
      pointer.active = true;
      schedule();
    };

    const handleMouseMove = event => handleMove(event.clientX, event.clientY);
    const handleTouchMove = event => {
      const touch = event.touches[0];
      if (touch) handleMove(touch.clientX, touch.clientY);
    };
    const handleLeave = () => {
      pointer.active = false;
      schedule();
    };

    const root = document.documentElement;
    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    window.addEventListener('touchmove', handleTouchMove, { passive: true });
    window.addEventListener('touchend', handleLeave);
    window.addEventListener('touchcancel', handleLeave);
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', relayout);
    root.addEventListener('mouseleave', handleLeave);
    window.addEventListener('blur', handleLeave);

    let observer = null;
    if (waving && rootRef.current && 'IntersectionObserver' in window) {
      observer = new IntersectionObserver(entries => {
        visible = entries.some(entry => entry.isIntersecting);
        schedule();
      });
      observer.observe(rootRef.current);
    }
    if (waving) document.fonts?.ready.then(relayout);

    schedule();

    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleLeave);
      window.removeEventListener('touchcancel', handleLeave);
      window.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', relayout);
      root.removeEventListener('mouseleave', handleLeave);
      window.removeEventListener('blur', handleLeave);
      if (repelLimit) letterRefs.current.forEach(letter => { if (letter) letter.style.transform = ''; });
    };
  }, [
    axes,
    fromFontVariationSettings,
    containerRef,
    radius,
    falloff,
    smoothing,
    fromColor,
    toColor,
    scale,
    lift,
    repelDistance,
    idleWave,
    fontSize,
    label,
    lineStarts
  ]);

  const words = label.split(/([ \n])/);
  const breakSet = new Set(lineStarts && !explicitLines ? lineStarts.split(',').map(Number) : []);
  let letterIndex = 0;

  return (
    <span
      ref={setRoot}
      className={`${className} variable-proximity`}
      onClick={onClick}
      style={{
        display: 'inline',
        ...(fontSize !== undefined ? { fontSize: typeof fontSize === 'number' ? `${fontSize}px` : fontSize } : {}),
        ...(lineStarts !== null ? { whiteSpace: 'nowrap' } : {}),
        ...style
      }}
      {...restProps}
    >
      {words.map((word, wordIndex) => wordIndex % 2 ? null : (
        <Fragment key={wordIndex}>
          {(words[wordIndex - 1] === '\n' || breakSet.has(wordIndex / 2)) && <br />}
          <span data-word="" style={{ display: 'inline-block', whiteSpace: 'nowrap' }}>
            {Array.from(word).map(letter => {
              const currentLetterIndex = letterIndex++;
              return (
                <span
                  key={currentLetterIndex}
                  ref={el => {
                    letterRefs.current[currentLetterIndex] = el;
                  }}
                  style={{
                    display: 'inline-block',
                    fontVariationSettings: fromFontVariationSettings,
                    color: fromColor || undefined,
                    transformOrigin: '50% 80%'
                  }}
                  aria-hidden="true"
                >
                  {letter}
                </span>
              );
            })}
            {words[wordIndex + 1] === ' ' && <span style={{ display: 'inline-block' }}>&nbsp;</span>}
          </span>
        </Fragment>
      ))}
      <span className="sr-only">{label}</span>
    </span>
  );
});

VariableProximity.displayName = 'VariableProximity';
export default VariableProximity;
