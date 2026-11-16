import './StatusBadge.css';

const TEXT = {
  idle: ['wait', 'Procurando seu microfone…'],
  requesting: ['wait', 'Pedindo permissão para usar o microfone…'],
  ready: ['ok', 'Microfone conectado'],
  denied: ['bad', 'Sem permissão para usar o microfone'],
  notfound: ['bad', 'Nenhum microfone encontrado'],
  busy: ['bad', 'Microfone ocupado por outro programa'],
  disconnected: ['bad', 'Microfone desconectado'],
  unsupported: ['bad', 'Este navegador não consegue usar o microfone'],
  error: ['bad', 'Algo deu errado com o microfone'],
};

export default function StatusBadge({ status, deviceLabel }) {
  const [tone, text] = TEXT[status] ?? TEXT.error;
  return (
    <div className={`status status--${tone}`} role="status">
      <span className="status__dot" aria-hidden="true" />
      <span>
        {text}
        {status === 'ready' && deviceLabel && <span className="status__device"> · {deviceLabel}</span>}
      </span>
    </div>
  );
}
