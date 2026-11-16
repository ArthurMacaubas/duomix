import { GearIcon, HelpIcon } from './Icons.jsx';
import './Header.css';

export default function Header({ onSettings, onHelp }) {
  return (
    <header className="header">
      <div className="header__brand">
        <img src="/logo.svg" alt="" width="46" height="46" />
        <div>
          <h1 className="header__title">
            Duo<span>Mix</span>
          </h1>
          <p className="header__tagline">Dois microfones, uma mesa.</p>
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
