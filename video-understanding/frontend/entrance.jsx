import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { SplitText } from 'gsap/SplitText';
import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(useGSAP, SplitText, DrawSVGPlugin, ScrollTrigger);

const desktop = '(min-width: 831px) and (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)';
const still = '(width < 831px), (hover: none), (pointer: coarse), (pointer: none), (prefers-reduced-motion: reduce)';
const main = document.querySelector('main');
const ridgeTravel = gsap.utils.mapRange(0.85, 1.05, 22, -29.4);

export default function EntranceMotion({ onTitleInteractive }) {
  useGSAP(() => {
    const select = gsap.utils.selector(main);
    const [title] = select('#rb-title');
    const [subtitle] = select('#rb-subtitle');
    const [line] = select('#horizon-line path');
    const [questionEntry] = select('#question-entry');
    const selectMountains = gsap.utils.selector(document.querySelector('.mountain-horizon'));
    const ridges = selectMountains('.ridge');
    const tints = selectMountains('.ridge-tint');
    const [mist] = selectMountains('.ridge-mist');
    const screenScale = () => Math.max(1, mist.ownerSVGElement.getScreenCTM().d);
    const media = gsap.matchMedia();
    let played = false;
    let questionRevealed = false;

    media.add(desktop, () => {
      let splits = [];
      function restoreTitles() {
        splits.forEach(split => split.revert());
        splits = [];
      }
      function enableTitle() {
        restoreTitles();
        onTitleInteractive(true);
      }
      function playEntrance() {
        const options = { type: 'chars', charsClass: 'intro-char', tag: 'span' };
        const headingSplit = SplitText.create(title, options);
        const subtitleSplit = SplitText.create(subtitle, options);
        splits = [headingSplit, subtitleSplit];
        const titleEnd = { opacity: 1, y: 0, filter: 'blur(0px)' };

        gsap.timeline({ defaults: { duration: 1.4, ease: 'power2.out' }, onComplete: enableTitle })
          .fromTo(headingSplit.chars, { opacity: 0, y: 24, filter: 'blur(10px)' },
            { ...titleEnd, stagger: { each: 0.08, from: 'start' } }, 0)
          .fromTo(subtitleSplit.chars, { opacity: 0, y: 16, filter: 'blur(10px)' },
            { ...titleEnd, stagger: { each: 0.04, from: 'start' } }, 0.5)
          .fromTo(line, { drawSVG: '0%' }, { drawSVG: '100%', duration: 0.8 }, 0.9);
      }
      const enter = played ? enableTitle : playEntrance;
      enter();
      played = true;

      gsap.timeline({
        defaults: { ease: 'none', duration: 1 },
        scrollTrigger: {
          start: 0,
          end: 'max',
          scrub: 1,
          invalidateOnRefresh: true,
        },
      })
        .fromTo(ridges, { y: 0, opacity: index => [1, 0.94, 0.75][index] }, {
          y: (_, ridge) => ridgeTravel(Number(ridge.dataset.speed)) / screenScale(),
          opacity: index => [0.55, 0.83, 1][index],
        }, 0)
        .fromTo(tints, { opacity: 0 }, { opacity: index => [0.95, 0.55, 0.85][index] }, 0);

      gsap.fromTo(mist, { x: 0, y: 0, opacity: 0.28 }, {
        x: () => 28 / screenScale(),
        y: () => -7 / screenScale(),
        opacity: 0.88,
        ease: 'power1.out',
        scrollTrigger: {
          start: 0,
          end: () => Math.max(1, Math.min(280, ScrollTrigger.maxScroll(window))),
          scrub: 0.55,
          invalidateOnRefresh: true,
        },
      });

      function watchQuestionEntry() {
        const slide = gsap.fromTo(questionEntry, { y: 10, opacity: 0.65 }, {
          y: 0,
          opacity: 1,
          duration: 0.28,
          ease: 'power2.out',
          clearProps: 'transform,opacity',
          paused: true,
          immediateRender: false,
        });
        const visibility = new IntersectionObserver(([entry]) => {
          if (entry.intersectionRatio < 0.3) return;
          visibility.disconnect();
          questionRevealed = true;
          slide.play();
        }, { threshold: 0.3 });
        function finishOnFocus() {
          visibility.disconnect();
          questionRevealed = true;
          slide.progress(1).pause();
        }
        visibility.observe(questionEntry);
        questionEntry.addEventListener('focusin', finishOnFocus, { once: true });
        return () => {
          visibility.disconnect();
          questionEntry.removeEventListener('focusin', finishOnFocus);
        };
      }
      const unwatchQuestionEntry = questionRevealed ? undefined : watchQuestionEntry();

      let refreshFrame = 0;
      const observer = new ResizeObserver(() => {
        cancelAnimationFrame(refreshFrame);
        refreshFrame = requestAnimationFrame(() => ScrollTrigger.refresh());
      });
      observer.observe(main);
      return () => {
        unwatchQuestionEntry?.();
        observer.disconnect();
        cancelAnimationFrame(refreshFrame);
        restoreTitles();
        onTitleInteractive(false);
      };
    });

    media.add(still, () => {
      gsap.set([title, subtitle], { opacity: 1, y: 0, filter: 'blur(0px)' });
      gsap.set(line, { drawSVG: '100%' });
      gsap.set(ridges, { y: 0, opacity: 1 });
      gsap.set(tints, { opacity: 0 });
      gsap.set(mist, { x: 0, y: 0, opacity: 0.28 });
    });

    return () => media.revert();
  }, { scope: main });

  return null;
}
