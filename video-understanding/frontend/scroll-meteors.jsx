import { useEffect, useRef } from 'react';
import ClickSpark from './components/ClickSpark.jsx';

const skyHeights = [0.08, 0.19, 0.11, 0.23, 0.15];

export default function ScrollMeteors() {
  const layer = useRef(null);
  const sparks = useRef(null);

  useEffect(() => {
    const viewport = layer.current;
    const pending = new Set();
    let previousY = Math.max(0, window.scrollY);
    let downwardTravel = 0;

    function launch([horizontal, vertical]) {
      const x = viewport.clientWidth * (horizontal + (Math.random() - 0.5) * 0.036);
      const y = viewport.clientHeight * vertical;
      sparks.current?.spark(x, y);
      const trail = viewport.querySelector('canvas:not(.scroll-meteor)');
      if (!trail) return;
      trail.style.transformOrigin = `${x - trail.offsetLeft}px ${y - trail.offsetTop}px`;
      trail.classList.add('scroll-meteor');
    }

    function clearPending() {
      pending.forEach(timer => window.clearTimeout(timer));
      pending.clear();
    }

    function scroll() {
      const y = Math.max(0, window.scrollY);
      const delta = y - previousY;
      previousY = y;
      if (delta <= 0) {
        downwardTravel = 0;
        clearPending();
        return;
      }
      downwardTravel += delta;
      if (downwardTravel < 7 || pending.size || viewport.querySelector('.scroll-meteor')) return;
      downwardTravel = 0;

      const count = 3 + Math.floor(Math.random() * 3);
      launch([0.11, skyHeights[0]]);
      for (let index = 1; index < count; index++) {
        const position = [0.11 + (0.75 * index) / (count - 1), skyHeights[index]];
        const timer = window.setTimeout(() => {
          pending.delete(timer);
          launch(position);
        }, 64 * index);
        pending.add(timer);
      }
    }

    window.addEventListener('scroll', scroll, { passive: true });
    window.addEventListener('blur', clearPending);
    return () => {
      window.removeEventListener('scroll', scroll);
      window.removeEventListener('blur', clearPending);
      clearPending();
    };
  }, []);

  return (
    <div ref={layer} className="scroll-meteors" aria-hidden="true">
      <ClickSpark ref={sparks} shape="streak" sparkColor="#ffffff"
        sparkCount={1} sparkRadius={480} sparkWidth={3} sparkSize={70}
        direction={164} spread={8} randomness={0.28} gravity={0.54}
        duration={650} easing="linear" glow={1.65} />
    </div>
  );
}
