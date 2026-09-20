import type { LiquidMetalProps } from "@paper-design/shaders-react";
import { useEffect, useRef, useState, type ComponentType } from "react";
import logo from "../assets/logo.svg";

/**
 * The Colo mark in the footer, with the Liquid Metal shader over it
 * (`@paper-design/shaders-react`, Apache-2.0, bundled — no third-party service).
 *
 * The mark itself is the same `logo.svg` the header and the auth screens use: the shader takes
 * the image's alpha as its shape mask, so the vector outline is the one source of truth and a
 * change to the logo carries over here with nothing to redraw.
 *
 * It is decoration, so it is never allowed to cost the page anything it cannot afford:
 * - the shader (a WebGL runtime, far larger than this screen) is imported only when the footer
 *   comes near the window, so the document list is not made to wait for it, and someone who
 *   never scrolls that far never fetches it;
 * - the plain SVG renders immediately and stays as the fallback — reduced motion, no WebGL, a
 *   failed import or a lost context all simply leave it in place. The library has no
 *   reduced-motion handling of its own, so that check is ours to make;
 * - the animation itself is the library's to pause: it stops the render loop while the element
 *   is out of the viewport or the tab is hidden, so nothing here has to drive `speed`.
 */

/** The look in the reference: chrome body, white highlights, rainbow dispersion at the edges. */
const METAL = {
  // Transparent, not the preset's grey: the canvas is a square and the mark is not, so anything
  // opaque here would sit in the footer as a grey tile around the logo.
  colorBack: "#00000000",
  colorTint: "#ffffff",
  repetition: 2,
  softness: 0.1,
  shiftRed: 0.3,
  shiftBlue: 0.3,
  distortion: 0.07,
  contour: 0.4,
  angle: 70,
  scale: 0.72,
} as const satisfies Partial<LiquidMetalProps>;

type LiquidMetal = ComponentType<LiquidMetalProps>;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Whether this browser can give the shader a context at all; false keeps the plain SVG.
 *
 * The probe context is thrown away immediately: browsers allow only a handful of live WebGL
 * contexts per page and drop the oldest to make room, so leaving this one to be collected
 * whenever could cost the shader — or another canvas — its own.
 */
function hasWebGl(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return Boolean(gl);
  } catch {
    return false;
  }
}

export function LiquidLogo({ size = 64 }: { size?: number }) {
  const [Shader, setShader] = useState<LiquidMetal | null>(null);
  const [onScreen, setOnScreen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);

  // The footer sits below a list that is usually taller than the window, so the chunk is only
  // worth fetching once the footer is about to be seen. `rootMargin` starts it slightly early,
  // so the mark is usually already metal by the time it is scrolled to.
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting), { rootMargin: "200px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!onScreen || Shader || prefersReducedMotion() || !hasWebGl()) return;
    let cancelled = false;
    void import("@paper-design/shaders-react")
      .then((module) => {
        if (!cancelled) setShader(() => module.LiquidMetal as LiquidMetal);
      })
      // Decoration: if the chunk cannot be fetched the plain mark below is already correct.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [onScreen, Shader]);

  return (
    <span ref={box} className="block shrink-0" style={{ width: size, height: size }} aria-hidden="true">
      {Shader ? (
        <Shader
          {...METAL}
          image={logo}
          width={size}
          height={size}
          // Turning the SVG into a mask takes a moment, and the canvas is empty until it is
          // done. Suspending instead would swap the mark out and back in again, which flickers
          // twice where this only ever shows one short gap, once per load.
          suspendWhenProcessingImage={false}
        />
      ) : (
        // Softened: the shader's chrome is a light mark, and a solid black one at this size
        // would sit much heavier in the footer than the thing it stands in for.
        <img src={logo} alt="" width={size} height={size} className="size-full opacity-75" />
      )}
    </span>
  );
}
