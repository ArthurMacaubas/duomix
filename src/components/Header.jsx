import { GearIcon, HelpIcon } from './Icons.jsx';
import './Header.css';

export default function Header({ onSettings, onHelp }) {
  return (
    <header className="header">
      <div className="header__stripe" aria-hidden="true" />
      <div className="header__brand">
        <img src="/mic.svg" alt="" width="44" height="44" />
        <div>
          <h1 className="header__title">Rubro</h1>
          <p className="header__tagline">Sua voz, no ponto.</p>
        </div>
      </div>
      <div className="header__actions">
        <button type="button" className="icon-btn" onClick={onHelp} aria-label="Ajuda e configuração inicial">
          <HelpIcon />
        </button>
        <button type="button" className="icon-btn" onClick={onSettings} aria-label="Ajustes">
          <GearIcon />
        </button>
      </div>
    </header>
  );
}
