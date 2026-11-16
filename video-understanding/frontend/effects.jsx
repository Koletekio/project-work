import { useEffect } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import VariableProximity from './components/VariableProximity.jsx';
import SplashCursor from './components/SplashCursor.jsx';
import Magnet from './components/Magnet/Magnet.jsx';
import GlareHover from './components/GlareHover.jsx';
import EntranceMotion from './entrance.jsx';
import QuestionTyping from './question-typing.jsx';
import CursorParticles from './cursor-particles.jsx';
import ScrollMeteors from './scroll-meteors.jsx';
import HeroOrb from './hero-orb.jsx';

const preference = window.matchMedia('(hover: hover) and (prefers-reduced-motion: no-preference)');
const title = document.querySelector('#rb-title');
const splash = document.querySelector('#rb-splash');
const titleContainer = { current: title.parentElement };
const card = { current: document.querySelector('#screen-panel') };
const titleText = '视频理解\n与问答';
const fontWeight = "'wght' 600";
const spring = { stiffness: 180, damping: 20, mass: 1 };
let titleInteractive = false;

function ButtonMagnet({ id }) {
  const button = document.getElementById(id);
  return <Magnet anchorRef={{ current: button.parentElement }} targetRef={{ current: button }}
    padding={80} maxOffset={6} magnetStrength={4} spring={spring} />;
}

function StarPointer() {
  useEffect(() => {
    const field = document.querySelector('.star-sea');
    if (!field) return;
    const stars = [...field.querySelectorAll('i')];
    const radius = 145;
    const maxOffset = 28;
    const active = new Set();
    let pointer;
    let frame = 0;

    function clear(star) {
      star.style.removeProperty('--pointer-x');
      star.style.removeProperty('--pointer-y');
      active.delete(star);
    }

    function update() {
      frame = 0;
      if (!pointer) return;
      const positions = stars.map(star => ({
        x: star.offsetLeft + star.offsetWidth / 2,
        y: star.offsetTop + star.offsetHeight / 2,
      }));
      stars.forEach((star, index) => {
        const { x, y } = positions[index];
        const dx = x - pointer.x;
        const dy = y - pointer.y;
        const distance = Math.hypot(dx, dy);
        if (distance >= radius) {
          if (active.has(star)) clear(star);
          return;
        }
        const strength = (1 - distance / radius) ** 2 * maxOffset;
        star.style.setProperty('--pointer-x', `${(distance ? strength * dx / distance : strength).toFixed(2)}px`);
        star.style.setProperty('--pointer-y', `${(distance ? strength * dy / distance : 0).toFixed(2)}px`);
        active.add(star);
      });
    }

    function move(event) {
      if (event.pointerType === 'touch') return;
      pointer = { x: event.clientX, y: event.clientY };
      if (!frame) frame = requestAnimationFrame(update);
    }

    function reset() {
      pointer = undefined;
      cancelAnimationFrame(frame);
      frame = 0;
      for (const star of active) clear(star);
    }

    window.addEventListener('pointermove', move, { passive: true });
    document.documentElement.addEventListener('pointerleave', reset);
    window.addEventListener('blur', reset);
    window.addEventListener('resize', reset);
    return () => {
      window.removeEventListener('pointermove', move);
      document.documentElement.removeEventListener('pointerleave', reset);
      window.removeEventListener('blur', reset);
      window.removeEventListener('resize', reset);
      reset();
    };
  }, []);
  return null;
}

const effects = [
  [title, () => <VariableProximity label={titleText} radius={120} falloff="exponential"
    repelDistance={8} containerRef={titleContainer} fromFontVariationSettings={fontWeight}
    toFontVariationSettings={fontWeight} />],
  [document.querySelector('#rb-glare'), () => <GlareHover interactionRef={card}
    className="rb-glare" mode="follow" glareColor="#E8D9B0" glareAngle={24}
    glareOpacity={0.13} glareSize={25} rimGlint={false} transitionDuration={200}
    width="100%" height="100%" borderRadius="inherit" />],
  [splash, () => <>
    <SplashCursor colors={['#E8D9B0']} rainbow={false} size={0.34} force={0.38} trail={0.29}
      momentum={0.38} swirl={0.65} intensity={2.4} shading={0} glow={0} quality="low"
      clickSplash={false} intro={false} zIndex={4} />
    <CursorParticles />
    <ScrollMeteors />
  </>],
  [document.querySelector('#rb-global'), () => <>
    <StarPointer />
    <ButtonMagnet id="upload" />
    <ButtonMagnet id="ask" />
  </>],
].map(([element, render]) => ({ element, render, fallback: element.innerHTML, root: null }));

function sync() {
  for (const mount of effects) {
    const waitsForEntrance = mount.element === title || mount.element === splash;
    const enabled = preference.matches && (!waitsForEntrance || titleInteractive);
    if (enabled && !mount.root) {
      mount.root = createRoot(mount.element);
      mount.root.render(mount.render());
    } else if (!enabled && mount.root) {
      mount.root.unmount();
      mount.root = null;
      mount.element.innerHTML = mount.fallback;
    }
  }
}

preference.addEventListener('change', sync);
sync();

const controller = createRoot(document.querySelector('#gsap-controller'));
flushSync(() => {
  controller.render(<>
    <EntranceMotion onTitleInteractive={enabled => {
      titleInteractive = enabled;
      sync();
    }} />
    <QuestionTyping />
  </>);
});

const heroScene = document.querySelector('#hero-scene');
createRoot(heroScene).render(<HeroOrb host={heroScene} />);
