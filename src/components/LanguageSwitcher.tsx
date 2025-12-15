import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

export const LanguageSwitcher: React.FC = () => {
  const { i18n } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const languages = [
    { code: 'en', label: 'English', flag: '🇺🇸' },
    { code: 'zh', label: '简体中文', flag: '🇨🇳' }
  ];

  // Determine current language object, fallback to first if not found
  // Also handle cases like 'zh-CN' matching 'zh'
  const currentLang = languages.find(l => i18n.language.startsWith(l.code)) || languages.find(l => l.code === 'en')!;

  const changeLanguage = (lng: string) => {
    i18n.changeLanguage(lng);
    setIsOpen(false);
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  return (
    <div className="language-switcher-container" ref={dropdownRef}>
      <div 
        className={`language-selector ${isOpen ? 'open' : ''}`} 
        onClick={() => setIsOpen(!isOpen)}
        title="Change Language"
      >
        <span className="lang-flag">{currentLang.flag}</span>
        <span className="lang-label">{currentLang.label}</span>
        <span className="dropdown-arrow">▼</span>
      </div>
      
      {isOpen && (
        <div className="language-options">
          {languages.map((lang) => (
            <div 
              key={lang.code} 
              className={`language-option ${i18n.language.startsWith(lang.code) ? 'active' : ''}`}
              onClick={() => changeLanguage(lang.code)}
            >
              <span className="lang-flag">{lang.flag}</span>
              <span className="lang-label">{lang.label}</span>
              {i18n.language.startsWith(lang.code) && <span className="check-mark">✓</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
