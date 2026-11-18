import './StatusBadge.css';

const TEXT = {
  idle: ['wait', 'Procurando o receptor…'],
  requesting: ['wait', 'Pedindo permissão para usar o receptor…'],
  ready: ['ok', 'Receptor conectado'],
  denied: ['bad', 'Sem permissão para usar o receptor'],
  notfound: ['bad', 'Nenhum receptor encontrado'],
  busy: ['bad', 'Receptor ocupado por outro programa'],
  disconnected: ['bad', 'Receptor desconectado'],
  unsupported: ['bad', 'Este navegador não consegue usar o microfone'],
  error: ['bad', 'Algo deu errado com o receptor'],
};

export default function StatusBadge({ status, channelCount, dualMono, mode, online, noSignal }) {
  const [baseTone, text] = TEXT[status] ?? TEXT.error;
  const tone = status === 'ready' && noSignal ? 'wait' : baseTone;
  return (
    <div className={`status status--${tone}`} role="status">
      <span className="status__dot" aria-hidden="true" />
      <span>
        {text}
        {status === 'ready' && (
          <span className="status__device">
            {' · '}
            {noSignal
              ? 'nenhum som chegando: confira o cabo e se o microfone não está no mudo do Windows'
              : mode === 'dual'
              ? online >= 2
                ? '2 receptores, 2 canais separados'
                : `${online} de 2 receptores no ar`
              : dualMono
                ? '1 canal (os dois lados chegam iguais)'
                : channelCount === 2
                  ? '2 canais separados'
                  : '1 canal (mono)'}
          </span>
        )}
      </span>
    </div>
  );
}
