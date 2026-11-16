import { Component, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { ContactShadows, Environment } from '@react-three/drei';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import {
  Color, DataTexture, EquirectangularReflectionMapping, Float32BufferAttribute,
  HalfFloatType, LinearFilter, LinearSRGBColorSpace, MathUtils, RGBAFormat,
  SphereGeometry, Vector3, DataUtils,
} from 'three';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

const initialCameraZ = 5.7;
const cameraFocus = new Vector3(0, -0.15, 0);
const motionQuery = '(min-width: 831px) and (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)';
const { clamp, damp, degToRad, lerp } = MathUtils;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const positionKey = 'videoUnderstanding.heroOrb.position.v1';
const minZoom = 0.70;
const maxZoom = 1.55;

function readSavedPosition() {
  try {
    const position = JSON.parse(window.localStorage.getItem(positionKey));
    if (position && [position.x, position.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) {
      const zoom = Number.isFinite(position.zoom) ? clamp(position.zoom, minZoom, maxZoom) : 1;
      return { x: position.x, y: position.y, zoom };
    }
  } catch {
    // A blocked store or an invalid value leaves the default placement in place.
  }
  return null;
}

function availablePosition(point, edge, gripRadius, obstacles) {
  const left = Math.min(edge, document.documentElement.clientWidth / 2);
  const top = Math.min(edge, window.innerHeight / 2);
  const right = document.documentElement.clientWidth - left;
  const bottom = window.innerHeight - top;
  const x = clamp(point.x, left, right);
  const y = clamp(point.y, top, bottom);
  const blocked = obstacles
    .map(element => element.getBoundingClientRect())
    .filter(rect => rect.width && rect.height && rect.bottom > 0 && rect.top < window.innerHeight)
    .map(rect => ({
      left: rect.left - gripRadius, right: rect.right + gripRadius,
      top: rect.top - gripRadius, bottom: rect.bottom + gripRadius,
    }));
  const xs = [x];
  const ys = [y];
  for (const rect of blocked) {
    xs.push(clamp(rect.left, left, right), clamp(rect.right, left, right));
    ys.push(clamp(rect.top, top, bottom), clamp(rect.bottom, top, bottom));
  }

  let closest;
  let bestDistance = Infinity;
  for (const cx of xs) {
    for (const cy of ys) {
      const distance = (cx - x) ** 2 + (cy - y) ** 2;
      if (distance >= bestDistance || blocked.some(rect =>
        cx > rect.left && cx < rect.right && cy > rect.top && cy < rect.bottom)) continue;
      closest = { x: cx, y: cy };
      bestDistance = distance;
    }
  }
  return closest;
}

function makeOrb() {
  const geometry = new SphereGeometry(1, 112, 72);
  const points = geometry.attributes.position;
  const colors = [];
  const directions = [];
  const pearl = new Color('#fff7e7');
  const silver = new Color('#e3edf5');
  const shadow = new Color('#b9bbca');
  const color = new Color();

  for (let i = 0; i < points.count; i++) {
    const x = points.getX(i);
    const y = points.getY(i);
    const z = points.getZ(i);
    const longitude = Math.atan2(z, x);
    const shoulder = Math.max(0, 1 - y * y);
    const fold = Math.sin(3 * longitude + 4 * y + 0.76 * Math.sin(5 * y));
    const twist = 0.42 * y;
    const radius = 0.83 + shoulder * (0.028 * Math.sin(3 * longitude - 4 * y) + 0.018 * fold);
    const cross = 0.5 + 0.5 * Math.sin(longitude + 2.9 * y);
    directions.push(x, y, z);
    points.setXYZ(i,
      (x * Math.cos(twist) - z * Math.sin(twist)) * radius,
      y * radius,
      (x * Math.sin(twist) + z * Math.cos(twist)) * radius,
    );
    color.copy(pearl).lerp(silver, cross * 0.63).lerp(shadow, 0.115 - 0.06 * fold);
    colors.push(color.r, color.g, color.b);
  }

  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setAttribute('orbDirection', new Float32BufferAttribute(directions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function addVeinEmission(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec3 orbDirection;\nvarying vec3 vOrbDirection;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvOrbDirection = orbDirection;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vOrbDirection;')
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      vec3 orb = normalize(vOrbDirection);
      float longitude = atan(orb.z, orb.x);
      float phase = 3.0 * longitude + 4.0 * orb.y + 0.76 * sin(5.0 * orb.y);
      float contour = pow(max(0.0, sin(phase)), 55.0)
        + 0.25 * pow(max(0.0, sin(phase + 0.31)), 64.0);
      float fade = smoothstep(0.0, 0.48, 1.0 - orb.y * orb.y);
      float crossTone = 0.5 + 0.5 * sin(longitude + 2.9 * orb.y);
      float rim = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.2);
      totalEmissiveRadiance += mix(vec3(0.72, 0.87, 1.0), vec3(1.0, 0.8, 0.56), crossTone)
        * (contour * fade * 0.31 + rim * 0.18) + vec3(0.095, 0.09, 0.087);`);
}

function makeEnvironment() {
  const width = 128;
  const height = 64;
  const pixels = new Uint16Array(width * height * 4);
  const panels = [
    { direction: new Vector3(-0.7, 0.6, 0.35).normalize(), color: [0.83, 1.01, 1.17], strength: 4.4, focus: 16 },
    { direction: new Vector3(0.6, 0.35, -0.62).normalize(), color: [1.13, 0.88, 0.64], strength: 3.8, focus: 27 },
    { direction: new Vector3(0.18, 0.8, 0.6).normalize(), color: [1, 0.96, 0.89], strength: 1.75, focus: 53 },
  ];
  const direction = new Vector3();
  for (let row = 0; row < height; row++) {
    const pitch = Math.PI * ((row + 0.5) / height - 0.5);
    for (let col = 0; col < width; col++) {
      const yaw = 2 * Math.PI * ((col + 0.5) / width - 0.5);
      direction.set(Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch));
      const rgb = [0.048, 0.052, 0.067];
      for (const panel of panels) {
        const light = panel.strength * Math.pow(Math.max(0, direction.dot(panel.direction)), panel.focus);
        for (let channel = 0; channel < 3; channel++) rgb[channel] += light * panel.color[channel];
      }
      const offset = (row * width + col) * 4;
      for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = DataUtils.toHalfFloat(rgb[channel]);
      pixels[offset + 3] = DataUtils.toHalfFloat(1);
    }
  }
  const texture = new DataTexture(pixels, width, height, RGBAFormat, HalfFloatType);
  texture.mapping = EquirectangularReflectionMapping;
  texture.colorSpace = LinearSRGBColorSpace;
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function OrbScene({ host, drag }) {
  const scrollGroup = useRef(null);
  const tiltGroup = useRef(null);
  const dragGroup = useRef(null);
  const tilt = useRef({ x: 0, y: 0 });
  const { camera, invalidate } = useThree();
  const geometry = useMemo(makeOrb, []);
  const environment = useMemo(makeEnvironment, []);

  useEffect(() => {
    const hero = document.querySelector('.workspace');
    const progress = { value: 0 };
    const media = gsap.matchMedia();
    let inHero = true;
    camera.lookAt(cameraFocus);
    host.classList.add('is-ready');
    drag.current.draw = invalidate;

    function apply() {
      const value = progress.value;
      scrollGroup.current.rotation.y = Math.PI * value;
      scrollGroup.current.scale.setScalar(lerp(1, 1.4, value));
      camera.position.z = lerp(initialCameraZ, 5.04, value);
      camera.lookAt(cameraFocus);
      invalidate();
    }

    media.add(motionQuery, () => {
      gsap.to(progress, {
        value: 1,
        ease: 'power3.out',
        onUpdate: apply,
        scrollTrigger: {
          trigger: hero,
          start: 0,
          end: () => Math.max(1, Math.min(hero.offsetHeight, ScrollTrigger.maxScroll(window))),
          scrub: 0.9,
        },
      });

      function point(event) {
        if (event.pointerType !== 'mouse' || !inHero || drag.current.pointer !== null) return;
        tilt.current.x = (0.5 - event.clientY / window.innerHeight) * 0.32;
        tilt.current.y = (event.clientX / window.innerWidth - 0.5) * 0.42;
        invalidate();
      }
      function resetTilt() {
        tilt.current.x = 0;
        tilt.current.y = 0;
        invalidate();
      }
      window.addEventListener('pointermove', point, { passive: true });
      document.documentElement.addEventListener('pointerleave', resetTilt);
      window.addEventListener('blur', resetTilt);
      return () => {
        window.removeEventListener('pointermove', point);
        document.documentElement.removeEventListener('pointerleave', resetTilt);
        window.removeEventListener('blur', resetTilt);
        resetTilt();
        progress.value = 0;
        apply();
      };
    });

    const visibility = new IntersectionObserver(([entry]) => {
      inHero = entry.isIntersecting;
      host.classList.toggle('is-outside-hero', !inHero);
    });
    visibility.observe(hero);
    return () => {
      visibility.disconnect();
      media.revert();
      host.classList.remove('is-ready');
      drag.current.draw = null;
    };
  }, [camera, drag, host, invalidate]);

  useEffect(() => () => {
    geometry.dispose();
    environment.dispose();
  }, [geometry, environment]);

  useFrame((_, delta) => {
    const rotation = tiltGroup.current.rotation;
    const target = tilt.current;
    const time = Math.min(0.05, delta);
    rotation.x = damp(rotation.x, target.x, 6.5, time);
    rotation.y = damp(rotation.y, target.y, 6.5, time);

    const userRotation = dragGroup.current.rotation;
    const userTarget = drag.current;
    const follow = reducedMotion.matches ? 1 : 1 - Math.exp(-20 * time);
    userRotation.x = lerp(userRotation.x, userTarget.pitch, follow);
    userRotation.y = lerp(userRotation.y, userTarget.yaw, follow);
    const remaining = Math.abs(rotation.x - target.x) + Math.abs(rotation.y - target.y)
      + Math.abs(userRotation.x - userTarget.pitch) + Math.abs(userRotation.y - userTarget.yaw);
    if (remaining > 0.001) invalidate();
  });

  return <>
    <Environment map={environment} environmentIntensity={0.58} />
    <ambientLight color="#e9edff" intensity={0.68} />
    <directionalLight color="#fff1d8" position={[-3, 4, 4]} intensity={1.62} />
    <directionalLight color="#cfdef8" position={[3, 1, -4]} intensity={0.72} />
    <group ref={scrollGroup}>
      <group ref={tiltGroup}>
        <group ref={dragGroup}>
          <mesh geometry={geometry} rotation={[degToRad(20), degToRad(-28), degToRad(-17)]}>
            <meshPhysicalMaterial vertexColors roughness={0.30} metalness={0.17}
              clearcoat={0.77} clearcoatRoughness={0.26} iridescence={0.10}
              toneMapped={false} onBeforeCompile={addVeinEmission} />
          </mesh>
          <group rotation={[degToRad(59), degToRad(-24), degToRad(-32)]}>
            <mesh>
              <torusGeometry args={[1.11, 0.0055, 6, 144]} />
              <meshBasicMaterial color="#bfb49e" />
            </mesh>
            <mesh rotation={[0, 0, degToRad(204)]}>
              <torusGeometry args={[1.11, 0.010, 8, 78, 1.24]} />
              <meshBasicMaterial color="#efe1bf" />
            </mesh>
            <mesh position={[-1.02, -0.43, 0]}>
              <sphereGeometry args={[0.026, 14, 12]} />
              <meshBasicMaterial color="#f0e4c9" />
            </mesh>
          </group>
        </group>
      </group>
    </group>
    <ContactShadows position={[0, -1.27, 0]} resolution={128} frames={1} scale={3.9}
      far={2.5} blur={3.8} opacity={0.36} color="#09051b" />
    <EffectComposer multisampling={0} depthBuffer frameBufferType={HalfFloatType}>
      <Bloom intensity={0.20} luminanceThreshold={0.78} luminanceSmoothing={0.28} mipmapBlur levels={5} />
    </EffectComposer>
  </>;
}

class SceneBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export default function HeroOrb({ host }) {
  const drag = useRef({ draw: null, pointer: null, pitch: 0, yaw: 0, x: 0, y: 0 });
  const grip = useRef(null);
  const placement = useRef(null);
  const zoom = useRef(1);
  const controls = useMemo(() => document.querySelector('#hero-orb-controls'), []);
  const obstacles = useMemo(() => Array.from(
    document.querySelectorAll('#screen-panel, .file-tools, #video-qa, #timeline'),
  ), []);

  function place(x, y, remember = true) {
    const position = availablePosition({ x, y }, host.clientWidth * 0.41, grip.current.clientWidth / 2 + 4, obstacles);
    if (!position) return null;
    if (remember) {
      placement.current = {
        x: position.x / document.documentElement.clientWidth,
        y: position.y / window.innerHeight,
        zoom: zoom.current,
      };
    }
    const left = `${position.x}px`;
    const top = `${position.y}px`;
    if (host.style.getPropertyValue('--hero-orb-x') === left
        && host.style.getPropertyValue('--hero-orb-y') === top) return false;
    for (const element of [host, controls]) {
      element.style.setProperty('--hero-orb-x', left);
      element.style.setProperty('--hero-orb-y', top);
    }
    return true;
  }

  function savePosition() {
    if (!placement.current) return;
    try {
      window.localStorage.setItem(positionKey, JSON.stringify(placement.current));
    } catch {
      // Position still works for the current page without browser storage.
    }
  }

  function applyZoom(value) {
    zoom.current = value;
    for (const element of [host, controls]) element.style.setProperty('--hero-orb-zoom', value);
  }

  function zoomBy(factor) {
    const previous = zoom.current;
    const next = clamp(previous * factor, minZoom, maxZoom);
    if (next === previous) return false;
    const rect = grip.current.getBoundingClientRect();
    applyZoom(next);
    if (place(rect.left + rect.width / 2, rect.top + rect.height / 2) === null) {
      applyZoom(previous);
      return false;
    }
    return true;
  }

  function onHeldWheel(event) {
    if (drag.current.pointer === null || !event.deltaY || event.ctrlKey || !event.cancelable) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    const delta = clamp(event.deltaY * unit, -200, 200);
    if (zoomBy(Math.exp(-delta / 660))) drag.current.moved = true;
  }

  useLayoutEffect(() => {
    let frame = 0;
    function restorePosition() {
      const position = placement.current;
      const x = position.x * document.documentElement.clientWidth;
      const y = position.y * window.innerHeight;
      if (zoom.current !== position.zoom) applyZoom(position.zoom);
      if (place(x, y, false) === null && zoom.current > 1) {
        applyZoom(1);
        place(x, y, false);
      }
    }
    function checkPlacement() {
      if (!placement.current || drag.current.pointer !== null || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (drag.current.pointer === null) restorePosition();
      });
    }
    placement.current = readSavedPosition();
    if (placement.current) restorePosition();
    window.addEventListener('resize', checkPlacement);
    window.addEventListener('scroll', checkPlacement, { passive: true });
    const regions = new ResizeObserver(checkPlacement);
    obstacles.forEach(element => regions.observe(element));
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', checkPlacement);
      window.removeEventListener('scroll', checkPlacement);
      window.removeEventListener('wheel', onHeldWheel);
      regions.disconnect();
    };
  }, [host, controls, obstacles]);

  function rotate(dx, dy) {
    const state = drag.current;
    state.yaw += dx;
    state.pitch = clamp(state.pitch + dy, -1.20, 1.20);
    state.draw?.();
  }

  function grab(event) {
    const state = drag.current;
    if (event.button !== 0 || state.pointer !== null) return;
    event.stopPropagation();
    state.pointer = event.pointerId;
    state.rotating = event.shiftKey;
    state.moved = false;
    state.x = event.clientX;
    state.y = event.clientY;
    const rect = event.currentTarget.getBoundingClientRect();
    state.offsetX = event.clientX - (rect.left + rect.width / 2);
    state.offsetY = event.clientY - (rect.top + rect.height / 2);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add('is-grabbing');
    window.addEventListener('wheel', onHeldWheel, { passive: false });
  }

  function move(event) {
    const state = drag.current;
    if (event.pointerId !== state.pointer) return;
    if (state.rotating) {
      const sensitivity = Math.PI / Math.max(100, event.currentTarget.clientWidth * 1.35);
      rotate((event.clientX - state.x) * sensitivity, (event.clientY - state.y) * sensitivity);
    } else if (event.clientX !== state.x || event.clientY !== state.y) {
      const moved = place(event.clientX - state.offsetX, event.clientY - state.offsetY);
      state.moved ||= moved;
    }
    state.x = event.clientX;
    state.y = event.clientY;
  }

  function release(event) {
    const state = drag.current;
    if (event.pointerId !== state.pointer) return;
    window.removeEventListener('wheel', onHeldWheel);
    if (state.moved) savePosition();
    state.pointer = null;
    event.currentTarget.classList.remove('is-grabbing');
  }

  function key(event) {
    if (event.key === '+' || event.key === '=' || event.key === '-') {
      event.preventDefault();
      if (zoomBy(event.key === '-' ? 1 / 1.12 : 1.12)) savePosition();
      return;
    }
    const delta = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0],
      ArrowUp: [0, -1], ArrowDown: [0, 1],
    }[event.key];
    if (!delta) return;
    event.preventDefault();
    if (event.shiftKey) {
      rotate(delta[0] * 0.18, delta[1] * 0.18);
    } else {
      const rect = event.currentTarget.getBoundingClientRect();
      if (place(rect.left + rect.width / 2 + delta[0] * 24, rect.top + rect.height / 2 + delta[1] * 24)) savePosition();
    }
  }

  return <>
    <SceneBoundary>
      <Canvas frameloop="demand" dpr={[1, 1.4]} resize={{ scroll: false }}
        gl={{ alpha: true, antialias: false, powerPreference: 'low-power' }}
        camera={{ fov: 43, near: 0.1, far: 30, position: [0, 0.28, initialCameraZ] }}>
        <OrbScene host={host} drag={drag} />
      </Canvas>
    </SceneBoundary>
    {createPortal(<button ref={grip} type="button" className="hero-orb-grip"
      aria-label="拖动星球或用方向键移动。按住星球时滚动鼠标滚轮，或按加减键缩放。按住 Shift 可以旋转。"
      onPointerDown={grab} onPointerMove={move} onLostPointerCapture={release}
      onPointerUp={release} onPointerCancel={release} onKeyDown={key} />, controls)}
  </>;
}
