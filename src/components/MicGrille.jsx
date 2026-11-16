import { BAND_COUNT } from '../hooks/useMicrophone.js';
import './MicGrille.css';

const COLS = BAND_COUNT * 2 - 1;
const ROWS = 9;
const CENTER = BAND_COUNT - 1;

// Pré-calcula quais furos ficam dentro da "cápsula" da grade do microfone.
const CELLS = [];
for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    const nx = (c - CENTER) / (CENTER + 0.6);
    const ny = (r - (ROWS - 1) / 2) / ((ROWS - 1) / 2 + 0.6);
    const fromBottom = ROWS - 1 - r;
    CELLS.push({
      key: `${r}-${c}`,
      band: Math.abs(c - CENTER),
      fromBottom,
      visible: nx * nx * 0.9 + ny * ny * 0.55 <= 1,
      tier: fromBottom === ROWS - 1 ? 'hot' : fromBottom >= ROWS * 0.6 ? 'high' : 'low',
    });
  }
}

/** Medidor de voz desenhado como a grade metálica do microfone. */
export default function MicGrille({ bands, idle = false, compact = false }) {
  return (
    <div
      className={`grille${idle ? ' grille--idle' : ''}${compact ? ' grille--compact' : ''}`}
      style={{ '--cols': COLS, '--rows': ROWS }}
      aria-hidden="true"
    >
      {CELLS.map((cell) => {
        if (!cell.visible) return <span key={cell.key} className="grille__hole grille__hole--none" />;
        const height = idle ? 0 : bands[cell.band] * ROWS;
        const lit = cell.fromBottom < Math.round(height);
        return (
          <span
            key={cell.key}
            className={`grille__hole${lit ? ` is-lit is-${cell.tier}` : ''}`}
            style={idle ? { animationDelay: `${(cell.band * 90 + cell.fromBottom * 60) % 1400}ms` } : undefined}
          />
        );
      })}
    </div>
  );
}
