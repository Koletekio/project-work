import { useEffect, useRef } from 'react';

const maxParticles = 30;

export default function CursorParticles() {
  const layer = useRef(null);
  useEffect(() => {
    const field = layer.current;
    const events = new AbortController();
    const options = { passive: true, signal: events.signal };
    let lastEmission;

    function emit(x, y, count, spread) {
      const particles = document.createDocumentFragment();
      for (let i = 0; i < count; i++) {
        const angle = (i / count + Math.random() * 0.16) * 2 * Math.PI;
        const distance = spread * (0.55 + Math.random() * 0.45);
        const depth = (Math.random() - 0.4) * 155;
        const particle = document.createElement('i');
        const style = particle.style;
        particle.className = 'cursor-particle';
        style.left = `${x}px`;
        style.top = `${y}px`;
        style.setProperty('--dx', `${Math.cos(angle) * distance}px`);
        style.setProperty('--dy', `${Math.sin(angle) * distance + 5}px`);
        style.setProperty('--dz', `${depth}px`);
        style.setProperty('--tilt', `${depth * 1.4}deg`);
        style.setProperty('--size', `${2.5 + Math.random() * 3.5}px`);
        style.setProperty('--life', `${440 + Math.random() * 180}ms`);
        particles.append(particle);
      }
      while (field.childElementCount + count > maxParticles) field.firstElementChild.remove();
      field.append(particles);
    }

    function press(event) {
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      emit(event.clientX, event.clientY, 10, 40);
      lastEmission = { x: event.clientX, y: event.clientY, time: event.timeStamp };
    }

    function drag(event) {
      if (event.pointerType !== 'mouse' || !(event.buttons & 1) || !lastEmission) return;
      const distance = Math.hypot(event.clientX - lastEmission.x, event.clientY - lastEmission.y);
      if (distance < 13 || event.timeStamp - lastEmission.time < 28) return;
      emit(event.clientX, event.clientY, 3, 22);
      lastEmission = { x: event.clientX, y: event.clientY, time: event.timeStamp };
    }

    const reset = () => { lastEmission = undefined; };
    window.addEventListener('pointerdown', press, options);
    window.addEventListener('pointermove', drag, options);
    window.addEventListener('pointerup', reset, options);
    window.addEventListener('pointercancel', reset, options);
    window.addEventListener('blur', reset, options);
    field.addEventListener('animationend', event => event.target.remove(), options);
    return () => events.abort();
  }, []);
  return <div ref={layer} className="cursor-particles" aria-hidden="true" />;
}
