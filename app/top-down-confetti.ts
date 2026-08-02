import type { CSSProperties } from "react";

export function topDownConfettiStyle(index: number): CSSProperties {
  const startX = ((index * 53) % 104) - 2;
  const driftX = ((index * 29) % 30) - 15;
  const spin = (index % 2 === 0 ? 1 : -1) * (460 + (index % 7) * 95);
  const size = 7 + (index % 5) * 1.25;

  return {
    "--confetti-start-x": `${startX}vw`,
    "--confetti-drift-x": `${driftX}vw`,
    "--confetti-drift-mid": `${driftX * 0.42}vw`,
    "--confetti-drift-late": `${driftX * 0.78}vw`,
    "--confetti-fall": `${112 + (index % 4) * 6}dvh`,
    "--confetti-size": `${size}px`,
    "--confetti-height": `${size * (index % 4 === 0 ? 1 : 1.65)}px`,
    "--confetti-delay": `${(index % 30) * 24 + Math.floor(index / 30) * 44}ms`,
    "--confetti-duration": `${3900 + (index % 7) * 145}ms`,
    "--confetti-spin-a": `${spin * 0.42}deg`,
    "--confetti-spin-b": `${spin * 0.78}deg`,
    "--confetti-spin-c": `${spin}deg`,
  } as CSSProperties;
}
