import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Layout } from '@/client/components/Layout';
import { GrindPage } from '@/client/pages/GrindPage';
import { WorkspacePage } from '@/client/pages/WorkspacePage';
import { ProgressPage } from '@/client/pages/ProgressPage';
import { StudyPage } from '@/client/pages/StudyPage';
import { SettingsPage } from '@/client/pages/SettingsPage';
import { HelpPage } from '@/client/pages/HelpPage';
import { MockPage } from '@/client/pages/MockPage';
import { TodayPage } from '@/client/pages/TodayPage';
import { RecognizePage } from '@/client/pages/RecognizePage';
import { EnvelopePage } from '@/client/pages/EnvelopePage';
import { ConceptPage, ConceptTrackPage, ConceptLessonPage } from '@/client/pages/ConceptPage';
import { StoriesPage } from '@/client/pages/StoriesPage';
import { PatternsPage } from '@/client/pages/PatternsPage';
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
            {/* Today — the guided daily routine — is the landing page. Grind
                moved to /grind; the routine deep-links into it. */}
            <Route path="/" element={<Navigate to="/today" replace />} />
            <Route path="/today" element={<TodayPage />} />
            <Route path="/grind" element={<GrindPage />} />
            <Route path="/recognize" element={<RecognizePage />} />
            <Route path="/envelope" element={<EnvelopePage />} />
            {/* Phase H3: the daily concept rep, and the AI-systems track. */}
            <Route path="/concept" element={<ConceptPage />} />
            <Route path="/concepts" element={<ConceptTrackPage />} />
            <Route path="/concepts/:concept" element={<ConceptLessonPage />} />
            {/* Phase H4: the story forge. */}
            <Route path="/stories" element={<StoriesPage />} />
            <Route path="/manual" element={<WorkspacePage />} />
            <Route path="/progress" element={<ProgressPage />} />
            <Route path="/study" element={<StudyPage />} />
            {/* The code shape of each pattern (+ "write it from memory"). */}
            <Route path="/patterns" element={<PatternsPage />} />
            {/* Mock interviews. /mock is the start card, /mock/:id one interview
                or its grade — a link that survives a reload. */}
            <Route path="/mock" element={<MockPage />} />
            <Route path="/mock/:id" element={<MockPage />} />
            {/* The config screen the wizard used to be the only way to reach.
                It is a normal route, gated by nothing: once `needed` is false
                the wizard never renders again, and a model or a key you cannot
                change from the browser is one you change with curl. */}
            <Route path="/settings" element={<SettingsPage />} />
            {/* The manual. Deliberately a plain route with no gate and no data
                fetch of its own: it is the page you send someone to when the
                app is confusing them, which includes when it is misconfigured
                and every other page is showing an error. */}
            <Route path="/help" element={<HelpPage />} />
            {/* Study replaced the pattern library; keep old bookmarks alive. */}
            <Route path="/library" element={<Navigate to="/study" replace />} />
          </Routes>
        )}
      </Layout>
    </BrowserRouter>
  );
}

export default App;
