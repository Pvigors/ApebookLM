"use client";

// Full color picker aligned with the Lexical playground's ColorPicker:
// hex input + preset swatches + a saturation/value square + a hue slider +
// a live preview bar. Used for both text color and highlight color in the
// note editor toolbar. Styling follows the app tokens (lavender #6d5ae6).

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

const WIDTH = 206;
const SAT_HEIGHT = 130;

// Same palette the playground ships (matches the reference screenshot).
const BASIC_COLORS = [
  "#d0021b", "#f5a623", "#f8e71c", "#8b572a", "#7ed321", "#417505", "#bd10e0", "#9013fe",
  "#4a90e2", "#50e3c2", "#b8e986", "#000000", "#4a4a4a", "#9b9b9b", "#ffffff",
];

interface RGB { r: number; g: number; b: number; }
interface HSV { h: number; s: number; v: number; }
interface Color { hex: string; rgb: RGB; hsv: HSV; }

const clamp = (value: number, max: number, min: number) =>
  value > max ? max : value < min ? min : value;

function toHex(value: string): string {
  if (!value.startsWith("#")) {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return "#000000";
    ctx.fillStyle = value;
    return ctx.fillStyle;
  }
  if (value.length === 4) {
    return "#" + value.slice(1).split("").map((c) => c + c).join("");
  }
  if (value.length === 7) return value;
  return "#000000";
}

function hex2rgb(hex: string): RGB {
  const parts = (toHex(hex).replace("#", "").match(/.{2}/g) || ["0", "0", "0"]).map((x) => parseInt(x, 16));
  return { r: parts[0] || 0, g: parts[1] || 0, b: parts[2] || 0 };
}

function rgb2hsv({ r, g, b }: RGB): HSV {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  const h = d === 0 ? 0 : max === r ? (((g - b) / d) % 6 + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const s = max === 0 ? 0 : d / max;
  return { h: 60 * h, s: s * 100, v: max * 100 };
}

function hsv2rgb({ h, s, v }: HSV): RGB {
  s /= 100; v /= 100;
  const i = Math.floor(h / 60);
  const f = h / 60 - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  const index = ((i % 6) + 6) % 6;
  const r = Math.round([v, q, p, p, t, v][index] * 255);
  const g = Math.round([t, v, v, q, p, p][index] * 255);
  const b = Math.round([p, p, t, v, v, q][index] * 255);
  return { r, g, b };
}

function rgb2hex({ r, g, b }: RGB): string {
  return "#" + [r, g, b].map((x) => clamp(Math.round(x), 255, 0).toString(16).padStart(2, "0")).join("");
}

function transformColor<M extends keyof Color>(format: M, value: Color[M]): Color {
  let hex = "#000000";
  let rgb: RGB = { r: 0, g: 0, b: 0 };
  let hsv: HSV = { h: 0, s: 0, v: 0 };
  if (format === "hex") { hex = toHex(value as string); rgb = hex2rgb(hex); hsv = rgb2hsv(rgb); }
  else if (format === "rgb") { rgb = value as RGB; hex = rgb2hex(rgb); hsv = rgb2hsv(rgb); }
  else if (format === "hsv") { hsv = value as HSV; rgb = hsv2rgb(hsv); hex = rgb2hex(rgb); }
  return { hex, rgb, hsv };
}

interface Position { x: number; y: number; }

/** A draggable surface that reports the clamped pointer position relative to
 *  itself. preventDefault on mousedown so the editor's text selection survives
 *  (the picked color must apply to the still-selected range). */
function MoveWrapper({
  className,
  style,
  onChange,
  children,
}: {
  className?: string;
  style?: React.CSSProperties;
  onChange: (p: Position) => void;
  children: ReactNode;
}) {
  const divRef = useRef<HTMLDivElement>(null);

  const report = (e: MouseEvent | React.MouseEvent) => {
    const div = divRef.current;
    if (!div) return;
    const { width, height, left, top } = div.getBoundingClientRect();
    onChange({ x: clamp(e.clientX - left, width, 0), y: clamp(e.clientY - top, height, 0) });
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    report(e);
    const onMouseMove = (ev: MouseEvent) => report(ev);
    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove, false);
      document.removeEventListener("mouseup", onMouseUp, false);
    };
    document.addEventListener("mousemove", onMouseMove, false);
    document.addEventListener("mouseup", onMouseUp, false);
  };

  return (
    <div ref={divRef} className={className} style={style} onMouseDown={onMouseDown}>
      {children}
    </div>
  );
}

export function ColorPicker({
  color,
  onChange,
}: {
  color: string;
  onChange: (hex: string) => void;
}) {
  const [self, setSelf] = useState<Color>(() => transformColor("hex", color || "#000000"));
  const [hexInput, setHexInput] = useState(self.hex);
  const skipApply = useRef(true);

  const satPos = useMemo(
    () => ({ x: (self.hsv.s / 100) * WIDTH, y: ((100 - self.hsv.v) / 100) * SAT_HEIGHT }),
    [self.hsv],
  );
  const huePos = useMemo(() => ({ x: (self.hsv.h / 360) * WIDTH }), [self.hsv]);

  // Apply to the editor whenever the picked color changes (skip the initial
  // mount so opening the popover doesn't re-stamp the current color).
  useEffect(() => {
    setHexInput(self.hex);
    if (skipApply.current) { skipApply.current = false; return; }
    onChange(self.hex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [self]);

  const onMoveSat = ({ x, y }: Position) =>
    setSelf(transformColor("hsv", { ...self.hsv, s: (x / WIDTH) * 100, v: 100 - (y / SAT_HEIGHT) * 100 }));
  const onMoveHue = ({ x }: Position) =>
    setSelf(transformColor("hsv", { ...self.hsv, h: (x / WIDTH) * 360 }));

  const onHexInput = (v: string) => {
    setHexInput(v);
    if (/^#[0-9a-fA-F]{6}$/.test(v)) setSelf(transformColor("hex", v));
  };

  return (
    <div style={{ width: WIDTH }} className="select-none">
      {/* hex input */}
      <div className="mb-2.5 flex items-center gap-2">
        <span className="text-[12px] text-ink2">Hex</span>
        <input
          name="hex-color"
          autoComplete="off"
          value={hexInput}
          onChange={(e) => onHexInput(e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
          spellCheck={false}
          className="h-7 flex-1 rounded-md border border-edge bg-panel px-2 text-[13px] text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent"
        />
      </div>

      {/* preset swatches */}
      <div className="mb-2.5 grid grid-cols-8 gap-1.5">
        {BASIC_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            title={c}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setSelf(transformColor("hex", c))}
            className="h-[18px] w-[18px] rounded border border-edge transition hover:scale-110"
            style={{ background: c }}
          />
        ))}
      </div>

      {/* saturation / value square */}
      <MoveWrapper
        onChange={onMoveSat}
        className="relative mb-2 cursor-crosshair rounded-md"
        style={{
          width: WIDTH,
          height: SAT_HEIGHT,
          backgroundColor: `hsl(${self.hsv.h}, 100%, 50%)`,
          backgroundImage:
            "linear-gradient(transparent, #000), linear-gradient(to right, #fff, transparent)",
        }}
      >
        <div
          className="absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
          style={{ left: satPos.x, top: satPos.y, backgroundColor: self.hex, boxShadow: "0 0 0 1px rgba(0,0,0,.25)" }}
        />
      </MoveWrapper>

      {/* hue slider */}
      <MoveWrapper
        onChange={onMoveHue}
        className="relative mb-2.5 cursor-ew-resize rounded-full"
        style={{
          width: WIDTH,
          height: 12,
          backgroundImage:
            "linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)",
        }}
      >
        <div
          className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white"
          style={{ left: huePos.x, backgroundColor: `hsl(${self.hsv.h}, 100%, 50%)`, boxShadow: "0 0 0 1px rgba(0,0,0,.25)" }}
        />
      </MoveWrapper>

      {/* preview */}
      <div className="h-6 w-full rounded-md border border-edge" style={{ backgroundColor: self.hex }} />
    </div>
  );
}
