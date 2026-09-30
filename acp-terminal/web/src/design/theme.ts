import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'system' | 'dark' | 'light';

const STORAGE_KEY = 'codepit_theme';
// The key's name before the rename, read until the preference is next saved
const LEGACY_STORAGE_KEY = 'acp_theme';

export function readThemePreference(): ThemePreference {
  const v = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
  return v === 'dark' || v === 'light' ? v : 'system';
}

/** Sets <html data-theme>; "system" removes it so tokens.css follows the OS. */
export function applyTheme(pref: ThemePreference): void {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
}

/** The theme actually showing, resolving "system" against the OS setting. */
export function resolvedTheme(pref: ThemePreference): 'dark' | 'light' {
  if (pref !== 'system') return pref;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function useTheme(): {
  preference: ThemePreference;
  resolved: 'dark' | 'light';
  setPreference: (pref: ThemePreference) => void;
} {
  const [preference, setPref] = useState<ThemePreference>(readThemePreference);
  const [resolved, setResolved] = useState<'dark' | 'light'>(() => resolvedTheme(readThemePreference()));

  useEffect(() => {
    applyTheme(preference);
    setResolved(resolvedTheme(preference));
    if (preference !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => setResolved(resolvedTheme('system'));
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [preference]);

  const setPreference = useCallback((pref: ThemePreference) => {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    if (pref === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, pref);
    setPref(pref);
    window.dispatchEvent(new CustomEvent('codepit-theme-change', { detail: pref }));
  }, []);

  // Keep several hook users (e.g. the xterm theme) in sync.
  useEffect(() => {
    const onExternal = (e: Event) => setPref((e as CustomEvent<ThemePreference>).detail);
    window.addEventListener('codepit-theme-change', onExternal);
    return () => window.removeEventListener('codepit-theme-change', onExternal);
  }, []);

  return { preference, resolved, setPreference };
}
