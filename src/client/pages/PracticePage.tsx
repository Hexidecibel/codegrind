// =============================================================================
// PracticePage — /practice, the Drills sub-tab
// =============================================================================
// Short reps that are not a full problem. Each card is one line and one tap;
// the drills keep their own routes (Today's steps deep-link straight to them).

import { Link } from 'react-router-dom';
import { ArrowRight, BookMarked, Calculator, Dumbbell, Mic, ScanSearch } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export const DRILLS: readonly { to: string; label: string; line: string; icon: LucideIcon }[] = [
  { to: '/recognize', label: 'Recognize', line: 'Read a problem, name its pattern. Five cards.', icon: ScanSearch },
  { to: '/envelope', label: 'Envelope', line: 'Quick back-of-the-envelope math reps.', icon: Calculator },
  { to: '/concept', label: 'Concept rep', line: 'Explain one concept out loud, then see how it went.', icon: BookMarked },
  { to: '/stories', label: 'Story forge', line: 'Draft a behavioral story by voice.', icon: Mic },
];

export function PracticePage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-4 p-4 sm:p-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Dumbbell className="h-6 w-6 text-primary" aria-hidden /> Drills
        </h1>
        <ul className="grid gap-3 sm:grid-cols-2">
          {DRILLS.map(({ to, label, line, icon: Icon }) => (
            <li key={to}>
              <Link
                to={to}
                className="flex h-full min-h-11 items-start gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/50"
              >
                <Icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{label}</span>
                  <span className="block text-sm text-muted-foreground">{line}</span>
                </span>
                <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
