import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Layout } from '@/client/components/Layout';
import { GrindPage } from '@/client/pages/GrindPage';
import { WorkspacePage } from '@/client/pages/WorkspacePage';
import { ProgressPage } from '@/client/pages/ProgressPage';
import { StudyPage } from '@/client/pages/StudyPage';
import { SetupWizard } from '@/client/components/setup/SetupWizard';
import { getSetupState } from '@/client/lib/api';
import type { SetupState } from '@/shared/types';

/**
 * The first-run gate.
 *
 * One request, on mount, before the router renders anything. `needed` is
 * DERIVED server-side from the two things that would make the app fail
 * confusingly — no usable API key, and a language with nothing it can serve —
 * so this is not an "onboarded" flag and a returning user cannot trip it by
 * clearing a browser profile.
 *
 * A FAILED request renders the app. The setup screen is help, and help that
 * appears when the server is merely unreachable would lock a working install
 * behind a form nobody can submit.
 */
function App() {
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [checked, setChecked] = useState(false);
  // Set when the wizard hands off. Purely a this-page-load latch, so that
  // finishing with (say) a bank whose generations all failed does not bounce
  // straight back into the wizard.
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    let live = true;
    getSetupState()
      .then((s) => {
        if (live) setSetup(s);
      })
      .catch(() => {
        /* unreachable server: render the app, let its own errors speak */
      })
      .finally(() => {
        if (live) setChecked(true);
      });
    return () => {
      live = false;
    };
  }, []);

  if (!checked) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  // The router stays OUTSIDE the branch: Layout's tabs are NavLinks, which need
  // a router context to render at all. The wizard therefore lives inside the
  // same shell as the app — which is also what you want to look at on your
  // first run: the thing you just installed, not a modal that could belong to
  // anything.
  return (
    <BrowserRouter>
      <Layout>
        {setup?.needed && !finished ? (
          <SetupWizard state={setup} onDone={() => setFinished(true)} />
        ) : (
          <Routes>
            <Route path="/" element={<GrindPage />} />
            <Route path="/manual" element={<WorkspacePage />} />
            <Route path="/progress" element={<ProgressPage />} />
            <Route path="/study" element={<StudyPage />} />
            {/* Study replaced the pattern library; keep old bookmarks alive. */}
            <Route path="/library" element={<Navigate to="/study" replace />} />
          </Routes>
        )}
      </Layout>
    </BrowserRouter>
  );
}

export default App;
