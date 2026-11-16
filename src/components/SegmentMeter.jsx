import './SegmentMeter.css';

/** Medidor de LEDs em segmentos, como numa mesa de som: ciano, amarelo no alto e vermelho no estouro. */
export default function SegmentMeter({ level, clip = false, segments = 18, horizontal = false }) {
  const lit = Math.round(level * segments);
  return (
    <div className={`segmeter${horizontal ? ' segmeter--h' : ''}`} aria-hidden="true">
      <span className={`segmeter__clip${clip ? ' is-on' : ''}`}>CLIP</span>
      <div className="segmeter__bar" style={{ '--n': segments }}>
        {Array.from({ length: segments }, (_, i) => {
          const tier = i >= segments - 2 ? 'hot' : i >= segments - 6 ? 'high' : 'low';
          return <span key={i} className={`segmeter__seg is-${tier}${i < lit ? ' is-lit' : ''}`} />;
        })}
      </div>
    </div>
  );
}
