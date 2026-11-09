export function hostTheme(value) {
  if (/^(dark|2|true)$/i.test(value || '')) return 'dark';
  if (/^(light|1|false)$/i.test(value || '')) return 'light';
  return null;
}

// No persisted editor override: Cloudreve's launch theme wins, otherwise follow OS changes without reloading the document.
export function followTheme(onChange) {
  const hash = new URLSearchParams(location.hash.slice(1));
  const query = new URLSearchParams(location.search);
  const fixed = hostTheme(hash.get('theme') || query.get('theme'));
  const media = matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    const dark = fixed ? fixed === 'dark' : media.matches;
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    onChange(dark);
  };
  apply();
  media.addEventListener('change', apply);
  return () => media.removeEventListener('change', apply);
}
