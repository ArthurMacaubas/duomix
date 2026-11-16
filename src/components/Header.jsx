import { GearIcon, HelpIcon } from './Icons.jsx';
import './Header.css';

export default function Header({ onSettings, onHelp }) {
  return (
    <header className="header">
      <div className="header__stripe" aria-hidden="true" />
      <div className="header__brand">
        <img src="/mic.svg" alt="" width="36" height="36" />
        <h1 className="header__title">
          Brasa <span>Mic</span>
        </h1>
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
