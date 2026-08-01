import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from '@/client/components/Layout';
import { GrindPage } from '@/client/pages/GrindPage';
import { WorkspacePage } from '@/client/pages/WorkspacePage';
import { ProgressPage } from '@/client/pages/ProgressPage';
import { LibraryPage } from '@/client/pages/LibraryPage';

function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<GrindPage />} />
          <Route path="/manual" element={<WorkspacePage />} />
          <Route path="/progress" element={<ProgressPage />} />
          <Route path="/library" element={<LibraryPage />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}

export default App;
