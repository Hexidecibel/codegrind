import { useEffect, useState } from 'react';
import { type Language } from '@/shared/languages';
import type { SetupLanguageState } from '@/shared/types';
import { getSettings, getSetupState, updateSettings } from '@/client/lib/api';
import { supportedLanguageOptions } from '@/client/lib/supported-languages';
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
 *
 * IT OFFERS WHAT THIS BUILD CAN RUN, NOT WHAT THE REGISTRY LISTS. It used to map
 * `LANGUAGES`, which includes Java, which has no sandbox harness — picking it
 * stored a language whose every problem load burned three generation calls and
 * then failed with an error blaming the model. The supported set is a fact about
 * the SERVER's disk, so it comes from `GET /api/setup/state` (`languages[]
 * .supported`), the same field the first-run wizard has always filtered on.
 * There is deliberately no second list here to keep in step with that one.
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
  // Null until the server has answered. `supportedLanguageOptions` treats null
  // as "offer nothing new" rather than "offer everything", so a failed or
  // in-flight request can never surface a language this build cannot run.
  const [languages, setLanguages] = useState<SetupLanguageState[] | null>(null);

  useEffect(() => {
    let live = true;
    void getSettings()
      .then((s) => {
        if (live) setLanguage(s.language);
      })
      .catch(() => {
        /* leave it unset; the trigger shows a placeholder rather than a lie */
      });
    void getSetupState()
      .then((s) => {
        if (live) setLanguages(s.languages);
      })
      .catch(() => {
        /* same: an unanswered question stays unanswered, it does not become yes */
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
        {supportedLanguageOptions(languages, language).map((o) => (
          <SelectItem key={o.language} value={o.language} disabled={!o.selectable}>
            {o.displayName}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
