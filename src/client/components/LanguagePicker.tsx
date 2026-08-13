import { useEffect, useState } from 'react';
import { LANGUAGES, LANGUAGE_META, type Language } from '@/shared/languages';
import { getSettings, updateSettings } from '@/client/lib/api';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/client/components/ui/select';

/**
 * The active-language control.
 *
 * It writes to the SERVER, not to localStorage, and that is the whole reason
 * the settings table exists. The language decides what gets GENERATED, and
 * generation happens server-side long before any browser asks for a problem —
 * `bin/seed-bank` filling the bank overnight, the warm-ahead jobs. A preference
 * only the client knows about would silently mean "show me Python problems from
 * the JavaScript bank", which is empty.
 *
 * Changing it affects the NEXT problem served, never the one on screen: a
 * problem's language is baked into its reference solution and every `expected`
 * value derived from it. That is why the solve surface shows a read-only badge
 * instead of this control.
 */
export function LanguagePicker({
  disabled,
  onChange,
}: {
  disabled?: boolean;
  /** Fired after a successful write, so the host can reload from the new bank. */
  onChange?: (language: Language) => void;
}) {
  const [language, setLanguage] = useState<Language | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    void getSettings()
      .then((s) => {
        if (live) setLanguage(s.language);
      })
      .catch(() => {
        /* leave it unset; the trigger shows a placeholder rather than a lie */
      });
    return () => {
      live = false;
    };
  }, []);

  async function commit(next: Language) {
    if (next === language) return;
    const previous = language;
    // Optimistic, then rolled back on failure. A picker that silently keeps
    // showing the new language after a failed write is how you end up staring
    // at a bank that "should" have Python problems in it.
    setLanguage(next);
    setSaving(true);
    try {
      const saved = await updateSettings({ language: next });
      setLanguage(saved.language);
      onChange?.(saved.language);
    } catch {
      setLanguage(previous);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Select
      value={language ?? undefined}
      onValueChange={(v) => void commit(v as Language)}
      disabled={disabled || saving || language === null}
    >
      <SelectTrigger className="h-11 w-[120px] lg:h-8" aria-label="Problem language">
        <SelectValue placeholder="Language" />
      </SelectTrigger>
      <SelectContent>
        {LANGUAGES.map((l) => (
          <SelectItem key={l} value={l}>
            {LANGUAGE_META[l].displayName}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
