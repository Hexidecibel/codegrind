import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from '@/client/components/Layout';
import { GrindPage } from '@/client/pages/GrindPage';
import { WorkspacePage } from '@/client/pages/WorkspacePage';
import { ProgressPage } from '@/client/pages/ProgressPage';
import { StudyPage } from '@/client/pages/StudyPage';

function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<GrindPage />} />
          <Route path="/manual" element={<WorkspacePage />} />
          <Route path="/progress" element={<ProgressPage />} />
          <Route path="/study" element={<StudyPage />} />
          {/* Study replaced the pattern library; keep old bookmarks alive. */}
          <Route path="/library" element={<Navigate to="/study" replace />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}

export default App;
