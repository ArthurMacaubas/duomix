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

export default function StatusBadge({ status, channelCount }) {
  const [tone, text] = TEXT[status] ?? TEXT.error;
  return (
    <div className={`status status--${tone}`} role="status">
      <span className="status__dot" aria-hidden="true" />
      <span>
        {text}
        {status === 'ready' && (
          <span className="status__device"> · {channelCount === 2 ? '2 canais (estéreo)' : '1 canal (mono)'}</span>
        )}
      </span>
    </div>
  );
}
