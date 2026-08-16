"use client";

import { useEffect, useRef } from "react";

type ConfettiShape = "circle" | "rectangle" | "triangle";

type ConfettiParticle = {
  x: number;
  y: number;
  size: number;
  color: string;
  velocityX: number;
  velocityY: number;
  drift: number;
  phase: number;
  rotation: number;
  rotationSpeed: number;
  opacity: number;
  shape: ConfettiShape;
};

const FALLBACK_COLORS = [
  "#2c5b43",
  "#df8055",
  "#496f86",
  "#7f8d67",
  "#c96549",
  "#d3a532",
];

export function confettiParticleCount(width: number, height: number) {
  return Math.min(420, Math.max(220, Math.round((width * height) / 2_800)));
}

function themeConfettiColors() {
  const styles = window.getComputedStyle(document.documentElement);
  const colors = ["--forest", "--apricot", "--sky", "--sage", "--rose", "--sand"]
    .map((token) => styles.getPropertyValue(token).trim())
    .filter(Boolean);
  return colors.length === 6 ? colors : FALLBACK_COLORS;
}

function createParticles(
  width: number,
  height: number,
  quantity: number,
  colors: string[],
): ConfettiParticle[] {
  const shapes: ConfettiShape[] = ["rectangle", "circle", "triangle"];
  return Array.from({ length: quantity }, () => ({
    x: Math.random() * width,
    y: Math.random() * height - height,
    size: 4 + Math.random() * 8,
    color: colors[Math.floor(Math.random() * colors.length)],
    velocityX: Math.random() * 2 - 1,
    velocityY: 2.2 + Math.random() * 3,
    drift: 0.35 + Math.random() * 0.45,
    phase: Math.random() * Math.PI * 2,
    rotation: Math.random() * Math.PI * 2,
    rotationSpeed: (Math.random() - 0.5) * 0.22,
    opacity: 0.74 + Math.random() * 0.26,
    shape: shapes[Math.floor(Math.random() * shapes.length)],
  }));
}

function drawParticle(context: CanvasRenderingContext2D, particle: ConfettiParticle) {
  context.save();
  context.translate(particle.x, particle.y);
  context.rotate(particle.rotation);
  context.scale(1, Math.cos(particle.rotation));
  context.globalAlpha = particle.opacity;
  context.fillStyle = particle.color;

  if (particle.shape === "circle") {
    context.beginPath();
    context.arc(0, 0, particle.size / 2, 0, Math.PI * 2);
    context.fill();
  } else if (particle.shape === "triangle") {
    context.beginPath();
    context.moveTo(0, -particle.size * 0.65);
    context.lineTo(particle.size * 0.62, particle.size * 0.55);
    context.lineTo(-particle.size * 0.62, particle.size * 0.55);
    context.closePath();
    context.fill();
  } else {
    context.fillRect(
      -particle.size / 2,
      -particle.size * 0.72,
      particle.size,
      particle.size * 1.44,
    );
  }

  context.restore();
}

export function ConfettiCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    let width = window.innerWidth;
    let height = window.innerHeight;
    let frameId = 0;
    let running = true;
    let lastFrameAt = performance.now();

    const resize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    };

    resize();
    const particles = createParticles(
      width,
      height,
      confettiParticleCount(width, height),
      themeConfettiColors(),
    );

    const drawFrame = (now: number) => {
      if (!running) return;
      const deltaFrames = Math.min(
        2.25,
        Math.max(0.5, (now - lastFrameAt) / (1_000 / 60)),
      );
      lastFrameAt = now;
      context.clearRect(0, 0, width, height);

      for (let index = particles.length - 1; index >= 0; index -= 1) {
        const particle = particles[index];
        particle.velocityY += 0.028 * deltaFrames;
        particle.x +=
          (particle.velocityX +
            Math.sin(particle.y / 30 + particle.phase) * particle.drift) *
          deltaFrames;
        particle.y += particle.velocityY * deltaFrames;
        particle.rotation += particle.rotationSpeed * deltaFrames;

        if (particle.y > height + particle.size * 2) {
          particles.splice(index, 1);
          continue;
        }
        drawParticle(context, particle);
      }

      if (particles.length) {
        frameId = window.requestAnimationFrame(drawFrame);
      } else {
        running = false;
        window.removeEventListener("resize", resize);
        context.clearRect(0, 0, width, height);
      }
    };

    window.addEventListener("resize", resize);
    frameId = window.requestAnimationFrame(drawFrame);
    return () => {
      running = false;
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", resize);
      context.clearRect(0, 0, width, height);
    };
  }, []);

  return <canvas ref={canvasRef} className="shopping-complete-confetti" aria-hidden="true" />;
}
