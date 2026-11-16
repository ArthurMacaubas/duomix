import './ProblemBanner.css';

/** Todo problema tem 3 partes: o que houve, o que fazer e um botão que faz por você. */
const PROBLEMS = {
  denied: {
    title: 'O navegador está bloqueando o receptor',
    steps: [
      'Clique no cadeado 🔒 ao lado do endereço do site.',
      'Em "Microfone", escolha "Permitir".',
      'Se continuar bloqueado: Configurações do Windows › Privacidade › Microfone, e ligue o acesso.',
    ],
    action: 'Tentar de novo',
  },
  notfound: {
    title: 'Não achei o receptor',
    steps: ['Encaixe o receptor na porta USB-C do computador.', 'Esta tela volta sozinha assim que ele for encontrado.'],
    action: 'Procurar de novo',
  },
  busy: {
    title: 'Outro programa está usando o receptor',
    steps: ['Feche programas como Discord, Zoom ou OBS.', 'Depois toque em "Tentar de novo".'],
    action: 'Tentar de novo',
  },
  disconnected: {
    title: 'O receptor foi desconectado',
    steps: ['Encaixe o receptor de novo.', 'A tela volta sozinha quando ele reconectar.'],
    action: 'Reconectar',
  },
  unsupported: {
    title: 'Este navegador não consegue usar o receptor',
    steps: ['Abra o app no Google Chrome ou no Microsoft Edge atualizado.'],
    action: null,
  },
  error: {
    title: 'Algo deu errado com o receptor',
    steps: ['Tire e coloque o receptor de novo.', 'Depois toque em "Tentar de novo".'],
    action: 'Tentar de novo',
  },
};

export default function ProblemBanner({ status, onRetry }) {
  const problem = PROBLEMS[status];
  if (!problem) return null;
  return (
    <section className="problem" role="alert">
      <div className="problem__icon" aria-hidden="true">
        !
      </div>
      <div className="problem__body">
        <h2 className="problem__title">{problem.title}</h2>
        <ol className="problem__steps">
          {problem.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        {problem.action && (
          <button type="button" className="btn-secondary" onClick={onRetry}>
            {problem.action}
          </button>
        )}
      </div>
    </section>
  );
}
